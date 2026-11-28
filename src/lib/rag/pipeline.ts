// One chat turn, start to finish. Everything it touches is injected, so the
// same function runs in production, in the pure checks and in the evaluation.
//
// Order (see the plan, section C):
//   fast path → understand (model proposes; code checks) → merge state →
//   retrieve every candidate → judge each against each requirement → compose
//   in code → final validation → commit state.
// The caller holds a per-identity lock, so turns of one customer arrive here
// one at a time, in order.

import { fetchCandidates, type CatalogDeps, type CatalogQuery, type CatalogResult } from "./catalog";
import { istToday } from "./dates";
import { applyGuards } from "./guards";
import { redactForModel } from "./numbers";
import { inquire } from "./inquire";
import type { LlmResult } from "./llm";
import { quickRead } from "./quick";
import { decide, type Decision } from "./requirements";
import { FIXED, clarifyReply, confirmQuestion, draftOf, draftText, filterChips, policyReply, searchReply, validateReply, type Outcome, type Reply } from "./reply";
import { bounded } from "../bounded";
import { isExpired, type Pending, type StateDoc, type StateStore } from "./state";
import type { SearchState } from "./types";
import {
  UNDERSTAND_FOLLOWUP, UNDERSTAND_SYSTEM, applyDelta, crossCheck, fastPath, judgeRemovals, normaliseExact, ownWords, revalidate, stripRestated, understandInput, validateProposal,
  type Proposal,
} from "./understand";

export interface PipelineDeps {
  now: () => Date;
  store: StateStore;
  catalog: CatalogDeps;
  llm: (system: string, user: string, signal: AbortSignal) => Promise<LlmResult>;
}

export interface TurnInput {
  message: string;
  /** From stateKey(); null = no identity → nothing is remembered. */
  key: string | null;
  /** The widget's "Start fresh" action. */
  reset?: boolean;
  /** A filter operation from the widget (a removed chip, an edit, a confirmed draft line). Applied as it is,
   *  after the same strict validation as a model's reading: a button needs no model. */
  op?: { set?: unknown; unset?: unknown; remove?: unknown; unsupported?: unknown; soft?: unknown; reset?: unknown };
  /** What a typed message does. "apply" (default; chat mode and the evaluation): the checked reading is applied.
   *  "draft" (filters mode with AI drafting): the reading is shown as a draft and nothing changes until the guest
   *  confirms it with an op. "off" (filters mode without AI): no model; the guest uses the filter buttons. */
  readMode?: "apply" | "draft" | "off";
  /** false: dates are never sent to the search and never kept (dated search is off until A9 is fixed). Default true. */
  dated?: boolean;
  /** A quick-answer button ("Yes, show them"): only the model-free fast paths may answer it (it is not counted
   *  against the daily limit, so it must never reach a model). */
  fastOnly?: boolean;
  /** Called when the turn starts searching the catalogue, so the widget can say so. */
  onStage?: (stage: "searching") => void;
}

export interface TurnLog {
  outcome: Outcome;
  intent: string;
  fast: string | null;
  ms: number;
  /** cacheRead / cacheWrite: input tokens served from / written to the provider's prompt cache (hit / miss). */
  llm: { provider: string | null; attempts: number; tokensIn: number; tokensOut: number; cacheRead?: number; cacheWrite?: number };
  catalog: { scope: string; pages: number; rows: number; total: number; complete: boolean } | { failed: string } | null;
  counts: { confirmed: number; possible: number; excluded: number } | null;
  cards: number;
  rev: number;
  defects: string[];
  /** why a clarifying question was asked (a reason code, never the message) */
  why?: string;
}

export interface TurnResult extends Reply {
  log: TurnLog;
  /** The search as it stands after this turn (what the widget's filter editor starts from). */
  state: SearchState;
}

const hasAnyRequirement = (s: SearchState) =>
  Object.keys(s).some((k) => !["shownIds", "consentFor", "soft", "nights"].includes(k));

export async function handleTurn(input: TurnInput, deps: PipelineDeps, signal: AbortSignal): Promise<TurnResult> {
  const started = deps.now().getTime();
  const today = istToday(deps.now());
  const log: TurnLog = {
    outcome: "other", intent: "-", fast: null, ms: 0,
    llm: { provider: null, attempts: 0, tokensIn: 0, tokensOut: 0 },
    catalog: null, counts: null, cards: 0, rev: 0, defects: [],
  };
  const readMode = input.readMode ?? "apply";
  const dated = input.dated ?? true;
  const controls = readMode !== "apply";
  // Dated search off: dates are neither searched nor kept, so nothing downstream can claim availability.
  const undated = (s: SearchState): SearchState => {
    if (dated || (!s.checkIn && !s.checkOut && !s.nights)) return s;
    const { checkIn: _i, checkOut: _o, nights: _n, ...rest } = s;
    return rest;
  };
  let current: SearchState = {};
  const finish = (r: Reply): TurnResult => {
    log.outcome = r.outcome;
    log.cards = r.cards.length;
    log.ms = deps.now().getTime() - started;
    // Filters mode: every reply carries the current filters, so the buttons stay usable after any reply,
    // a failed model call included.
    const chips = r.chips ?? (controls ? filterChips(current, today) : undefined);
    return { ...r, ...(chips ? { chips } : {}), log, state: current };
  };
  const fixed = (outcome: Outcome, text: string, pending: Pending | null = null): Reply => ({ text, cards: [], outcome, pending });
  // One catalogue call per distinct query per turn (recognising a place and searching it are the same call).
  const asked = new Map<string, Promise<CatalogResult>>();
  const search = (q: CatalogQuery): Promise<CatalogResult> => {
    const k = JSON.stringify([q.place ?? "", q.checkIn ?? "", q.checkOut ?? ""]);
    if (!asked.has(k)) asked.set(k, fetchCandidates(q, deps.catalog, signal));
    return asked.get(k)!;
  };

  // Every state call waits DB_WAIT_MS at most, and after one failed call the rest of this turn does not wait on
  // the store again (a failed write would otherwise retry like a version conflict: two more waits). Time only, not
  // the turn's signal: a customer who leaves mid-turn still has what they asked kept.
  let storeDown: unknown = null;
  const guarded = <T,>(call: () => Promise<T>): Promise<T> =>
    storeDown ? Promise.reject(storeDown) : bounded(call()).catch((err: unknown) => { storeDown = err ?? new Error("state store failed"); throw err; });
  const store: StateStore = {
    load: (k) => guarded(() => deps.store.load(k)),
    commit: (k, r, next) => guarded(() => deps.store.commit(k, r, next)),
  };

  // ── load ──
  let doc: StateDoc | null = null;
  try {
    doc = input.key ? await store.load(input.key) : null;
  } catch {
    // Not knowing what the customer asked so far is not the same as "nothing": do
    // not search, and do not spend a model call, on a state we could not read.
    return finish(fixed("not_processed", FIXED.not_processed));
  }
  const preface: string[] = [];
  let rev = doc?.rev ?? 0;
  let state: SearchState = {};
  let pending: Pending | null = null;
  if (doc && !isExpired(doc, started)) {
    const checked = revalidate(doc.state, today);
    state = undated(checked.state);
    pending = doc.pending;
    if (checked.droppedDates) preface.push("Your earlier dates have passed, so I've cleared them.");
  } else if (doc && hasAnyRequirement(doc.state)) {
    preface.push("Starting a fresh search.");
  }

  current = state;
  const commit = async (next: SearchState, nextPending: Pending | null): Promise<boolean> => {
    current = next;
    if (!input.key) return true;
    try {
      const ok = await store.commit(input.key, rev, { state: next, pending: nextPending, updatedAt: deps.now().getTime() });
      if (ok) rev++;
      log.rev = rev;
      return ok;
    } catch {
      return false;
    }
  };

  // ── fast paths ──
  const fast = input.reset ? ({ kind: "reset" } as const) : input.op ? null : fastPath(input.message, pending !== null);
  log.fast = fast?.kind ?? null;
  let proposal: Proposal | null = null;

  if (fast?.kind === "greeting") return finish(fixed("greeting", FIXED.greeting, pending));
  if (fast?.kind === "thanks") return finish(fixed("thanks", FIXED.thanks, pending));
  if (fast?.kind === "reset") {
    if (!(await commit({}, null)) && input.key) {
      rev = (await store.load(input.key).catch(() => null))?.rev ?? 0;
      if (!(await commit({}, null))) return finish(fixed("not_processed", FIXED.not_processed));
    }
    return finish(fixed("reset", FIXED.reset));
  }
  // A button (removed chip, edited filter, confirmed draft line): the same validation and merge as any other
  // change, without asking a model what a button meant.
  const o = input.op;
  const chip = o ? validateProposal({ intent: "search", set: o.set ?? {}, unset: o.unset, remove: o.remove, unsupported: o.unsupported, soft: o.soft, reset: o.reset === true }) : null;
  // A button never reaches the model: an op that is unusable, or changes nothing, ends here.
  if (o && (!chip || typeof chip === "string")) return finish(fixed("not_processed", FIXED.not_processed));
  if (o && chip && typeof chip !== "string" && !(chip.unset.length || chip.remove.length || Object.keys(chip.set).length || chip.unsupported.length || chip.soft.length || chip.reset)) {
    return finish(fixed("not_processed", FIXED.not_processed));
  }
  if (chip && typeof chip !== "string" && (chip.unset.length > 0 || chip.remove.length > 0 || Object.keys(chip.set).length > 0 || chip.unsupported.length > 0 || chip.soft.length > 0 || chip.reset)) {
    proposal = chip;
    state = undated(applyDelta(state, chip));
    log.intent = "search";
    log.fast = "chip";
  } else if (fast?.kind === "consent" && pending?.kind === "confirm") {
    // The answer to "should I change your search to …?": only now is that change applied.
    if (!fast.yes) {
      await commit(state, null);
      return finish(fixed("declined", FIXED.kept));
    }
    proposal = pending.proposal;
    state = undated(applyDelta(state, proposal));
    log.intent = "search";
  } else if (fast?.kind === "consent" && pending?.kind === "consent") {
    if (!fast.yes) {
      await commit(state, null);
      return finish(fixed("declined", FIXED.declined));
    }
    state = { ...state, consentFor: pending.signature };
    log.intent = "search";
  } else if (readMode === "off" || input.fastOnly) {
    // Filters mode without AI: a typed message changes nothing; the buttons do.
    await commit(state, null);
    return finish(fixed("use_filters", FIXED.use_filters));
  } else {
    // ── understand ──
    // A simple message is read without a model: every word accounted for, or not at all.
    const prepare = (p: Proposal) => stripRestated(normaliseExact(input.message, applyGuards(input.message, ownWords(input.message, p), state, today)), state);
    // Only when the site's search resolves the phrase to a place of that very name —
    // not a fuzzy correction ("actually panaji" → Panaji is the model's job).
    const isPlace = async (phrase: string) => {
      const r = await search({ place: phrase });
      const same = (a: string, b: string) => a.toLowerCase().replace(/[^a-z]/g, "") === b.toLowerCase().replace(/[^a-z]/g, "");
      return r.kind === "ok" && (r.scope === "place" || r.scope === "nearby") && !r.corrected && !!r.placeName && same(r.placeName, phrase);
    };
    let quick = await quickRead(input.message, isPlace).catch(() => null);
    // The same cross-checks as a model's reading; a doubt sends the message to the model.
    if (quick && crossCheck(input.message, prepare(quick), today, state)) quick = null;
    if (quick) log.fast = "quick";

    const llm: LlmResult = quick ? { ok: true, json: null, provider: "none", tokensIn: 0, tokensOut: 0, attempts: 0, ms: 0 } : await deps.llm(
      hasAnyRequirement(state) ? UNDERSTAND_FOLLOWUP : UNDERSTAND_SYSTEM,
      understandInput({
        message: redactForModel(input.message),
        state,
        pending: pending ? (pending.kind === "confirm" ? pending.question : "Would you like to see stays I could not fully verify? (yes / no)") : null,
        shownCount: state.shownIds?.length ?? 0,
        today,
      }),
      signal
    );
    log.llm = {
      provider: llm.ok && !quick ? llm.provider : null, attempts: llm.attempts, tokensIn: llm.ok ? llm.tokensIn : 0, tokensOut: llm.ok ? llm.tokensOut : 0,
      ...(llm.ok && llm.cacheRead !== undefined ? { cacheRead: llm.cacheRead, cacheWrite: llm.cacheWrite } : {}),
    };
    if (!llm.ok) {
      // Out of daily budget, or every provider out of quota: say we are busy. Fast paths,
      // resets and filter chips keep working because they need no model.
      const busy = llm.why === "cap" || llm.why === "unavailable";
      if (readMode === "draft") return finish(fixed(busy ? "busy" : "not_processed", FIXED.draft_busy, pending));
      return finish(fixed(busy ? "busy" : "not_processed", busy ? FIXED.busy : FIXED.not_processed, pending));
    }

    const parsed = quick ?? validateProposal(llm.json);
    // The model answered but with nothing usable (e.g. "{}" to an injection attempt): not a
    // technical failure, so don't say "try again"; nothing is applied.
    if (parsed === null) {
      log.why = "unusable_reading";
      return finish(fixed("other", FIXED.other, pending));
    }
    if (typeof parsed === "string") return finish(fixed("clarify", clarifyReply(parsed), pending));
    proposal = prepare(parsed);
    log.intent = proposal.intent;

    const changes =
      proposal.reset || proposal.unset.length > 0 || proposal.remove.length > 0 || proposal.soft.length > 0 ||
      proposal.unsupported.length > 0 || proposal.nights !== undefined || Object.keys(proposal.set).length > 0;
    // A message that changes the search IS a search, whatever the model called it —
    // except a question about a stay already shown ("does the second one have a
    // pool?" must not make a pool a requirement).
    const aboutShown =
      (proposal.intent === "listing_question" || proposal.intent === "compare") &&
      (proposal.target.ordinals.length > 0 || proposal.target.names.length > 0);
    // The customer's own booking ("how do I add a guest to my booking?", "meri last booking ka refund") is
    // Support even when it names a place; general travel advice with no requirement is not a search.
    const ownBooking = (proposal.intent === "booking_management" || proposal.intent === "policy") && OWN_BOOKING.test(input.message);
    const advice = proposal.intent === "travel_info" && Object.keys(proposal.set).length === 0 && !proposal.unset.length && !proposal.remove.length && !proposal.reset;
    if (ownBooking) proposal = { ...proposal, intent: "booking_management" };
    if (changes && proposal.intent !== "search" && !aboutShown && !ownBooking && !advice) proposal = { ...proposal, intent: "search" };

    if (proposal.intent !== "search") {
      // The customer moved on: an unanswered "would you like to see them?" must not
      // be answered by a later, unrelated "ok". The write also refreshes the idle clock.
      await commit(state, null);
      pending = null;
      switch (proposal.intent) {
        case "policy": return finish(fixed("policy", policyReply(proposal.policyTopic), pending));
        case "booking_management": return finish(fixed("support", FIXED.support, pending));
        case "greeting": return finish(fixed("greeting", FIXED.greeting, pending));
        case "travel_info": return finish(fixed("travel_off", FIXED.travel_off, pending));
        case "listing_question":
        case "compare": {
          const a = await inquire(proposal, state, deps.catalog, signal, input.message);
          if (a.kind === "unavailable") return finish(fixed("unavailable", FIXED.info_unavailable, pending));
          if (a.kind === "which") return finish(fixed("which_stay", FIXED.which_stay, pending));
          return finish(fixed("info", a.text, pending));
        }
        default: return finish(fixed("other", FIXED.other, pending));
      }
    }

    // A removal the customer did not ask for is dropped here; one they asked for without saying what is asked about.
    const judged = judgeRemovals(input.message, proposal, state);
    proposal = judged.p;
    const problem = judged.doubt ? "negation" : crossCheck(input.message, proposal, today, state);
    if (readMode === "draft") {
      // Nothing is applied: the guest sees each change and confirms it (an op). A doubt is shown, not decided.
      const notes: string[] = [];
      if (judged.doubt) notes.push(`which filter to remove? Use the × on its chip.`);
      let p = proposal;
      if (problem === "budget_basis") {
        notes.push("that budget is a total or per person; only a nightly budget can be used.");
        const { price: _notNightly, ...rest } = p.set; // left out, not removed: the current budget stays as it is
        p = { ...p, set: rest };
      } else if (problem && !(problem.startsWith("dates_") && !dated) && problem !== "negation") notes.push(clarifyReply(problem));
      else if (problem === "negation" && !judged.doubt) notes.push(clarifyReply(problem));
      if (!dated && (p.set.checkIn || p.set.checkOut || p.nights)) notes.push("dates are picked on the stay page.");
      for (const u of p.unsupported) notes.push(`listings can't confirm "${u}"; you'll be asked before such stays are shown.`);
      const next = undated(applyDelta(state, p));
      const draft = draftOf(input.message, state, next, p.reset, notes, today);
      await commit(state, null);
      return finish({ text: draftText(draft), cards: [], outcome: "draft", pending: null, draft });
    }
    if (problem) {
      log.why = judged.doubt ? "removal_unnamed" : problem;
      // A doubt about how to read the change: one focused question showing the search it would give.
      // Nothing is applied until the customer says yes; the current search stays as it is.
      const question = CONFIRMABLE.has(problem) ? confirmQuestion(state, undated(applyDelta(state, proposal)), today) : null;
      if (question) {
        await commit(state, { kind: "confirm", proposal, question });
        return finish(fixed("clarify", question, null));
      }
      await commit(state, null);
      return finish(fixed("clarify", clarifyReply(problem)));
    }
    state = undated(applyDelta(state, proposal));
    // "new search karo": a reset that brings nothing new is the reset reply, as the fast path gives it
    if (proposal.reset && !hasAnyRequirement(state)) {
      await commit(state, null);
      return finish(fixed("reset", FIXED.reset));
    }
    if (proposal.reset) preface.push("Starting a fresh search.");
  }

  if (!hasAnyRequirement(state)) {
    await commit(state, null);
    // Filters mode: the buttons set the search (the typed example would invite dates the pilot does not use).
    return finish(fixed("need_details", [...preface, controls ? FIXED.use_filters : FIXED.need_details].join("\n")));
  }

  // ── retrieve, judge, compose ──
  let catalog: CatalogResult;
  let decision: Decision | null = null;
  input.onStage?.("searching");
  catalog = await search(dated ? { place: state.place, checkIn: state.checkIn, checkOut: state.checkOut } : { place: state.place });
  if (catalog.kind === "ok") {
    decision = decide(catalog.rows, state);
    log.catalog = { scope: catalog.scope, pages: catalog.pages, rows: catalog.rows.length, total: catalog.total, complete: catalog.complete };
    log.counts = { confirmed: decision.confirmed.length, possible: decision.possible.length, excluded: decision.excluded.length };
  } else {
    log.catalog = { failed: catalog.why };
  }

  const reply = searchReply({ state, catalog, decision, today, preface, controls });
  log.defects = validateReply(reply, { state, catalog, decision });
  // A template bug must not reach a customer — nor be saved, or the same state
  // would fail again on every later turn.
  if (log.defects.length) return finish(fixed("not_processed", FIXED.not_processed));

  // ── commit: what the customer asked is kept even if the search failed ──
  const next: SearchState = { ...state, shownIds: reply.cards.map((c) => c._id) };
  if (!reply.cards.length) delete next.shownIds;
  if (!(await commit(next, reply.pending))) {
    // Another instance moved the state. Re-apply this turn's change to the newer state, once.
    const fresh = input.key ? await store.load(input.key).catch(() => null) : null;
    rev = fresh?.rev ?? 0;
    const base = fresh && !isExpired(fresh, started) ? revalidate(fresh.state, today).state : {};
    const merged: SearchState = undated(proposal ? applyDelta(base, proposal) : { ...base, consentFor: state.consentFor });
    await commit(merged, null);
    // The reply above was built on the older state: ask for a resend rather than show it.
    return finish(fixed("retry", FIXED.retry));
  }
  return finish(reply);
}

const CONFIRMABLE = new Set(["numbers", "negation", "budget_direction"]);
const OWN_BOOKING = /(?<![\p{L}\p{M}])((my|meri|mera|mere|our|hamari|hamara|humari)\s+(last\s+|previous\s+|existing\s+|current\s+|upcoming\s+)?(booking|reservation)|already booked|booking (id|number|no)|मेरी (पिछली )?बुकिंग)(?![\p{L}\p{M}])/iu;
