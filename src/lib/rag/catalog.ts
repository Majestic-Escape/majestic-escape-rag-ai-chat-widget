// The one source of candidate stays: server.me's public search
// (GET /properties/search-properties) — the same search the website uses, so
// place resolution (typos, aliases, Hindi, stay names), the public-listing rule
// and date availability (the night ledger) are never re-implemented here.
//
// Measured contract (see eval/contract/README.md), and why we send so little:
//  • the API silently drops or inverts several filters (`placeType=entire`,
//    `pets`, `bookingType`, a single date, any unknown name) — so we send ONLY
//    the place and the dates and enforce everything else in requirements.ts;
//  • it widens the place by itself (`mode: "nearby"`: stays up to 250 km away)
//    and returns the whole catalogue for vague words (`mode: "all"`) — so rows
//    are in-place matches only for `place` / `text`;
//  • the default page is 16 and `limit` is capped at 50 — so we page until
//    every row is in, and say "incomplete" rather than "no matches" otherwise.

import type { Listing } from "./types";

const PAGE_SIZE = 50;
export const MAX_PAGES = 4;
const CALL_TIMEOUT_MS = 3000;

export interface CatalogQuery {
  place?: string;
  checkIn?: string;
  checkOut?: string;
}

/** Where the returned rows are, relative to what was asked. */
export type Scope =
  | "everywhere" // no place asked
  | "place" // inside the place asked
  | "name" // matched a stay's name / keywords
  | "nearby" // NOT in the place asked — the API widened it; alternatives only
  | "unrecognised"; // a place was asked and the API did not understand it

export type CatalogResult =
  | {
      kind: "ok";
      scope: Scope;
      /** false = the page cap was reached; never conclude "no matches" from this. */
      complete: boolean;
      rows: Listing[];
      total: number;
      placeName?: string;
      placeLabel?: string;
      corrected: boolean;
      pages: number;
    }
  | { kind: "failed"; why: string };

export function searchUrl(baseUrl: string, q: CatalogQuery, page: number): string {
  const u = new URL(`${baseUrl.replace(/\/+$/, "")}/properties/search-properties`);
  if (q.place) u.searchParams.set("location", q.place);
  // Both or neither: the API ignores a lone date without saying so.
  if (q.checkIn && q.checkOut) {
    u.searchParams.set("from", q.checkIn);
    u.searchParams.set("to", q.checkOut);
  }
  u.searchParams.set("limit", String(PAGE_SIZE));
  u.searchParams.set("page", String(page));
  return u.toString();
}

interface Page {
  rows: Listing[];
  total: number;
  mode: string;
  placeName?: string;
  placeLabel?: string;
  corrected: boolean;
}

/** Anything that is not exactly the contract is a failure — never an empty result. */
export function parsePage(status: number, body: unknown): Page | string {
  if (status !== 200) return `http ${status}`;
  if (!body || typeof body !== "object") return "body is not an object";
  const b = body as { data?: unknown; pagination?: { totalCount?: unknown }; search?: { mode?: unknown; place?: unknown; corrected?: unknown } };
  if (!Array.isArray(b.data)) return "data is not an array";
  const total = b.pagination?.totalCount;
  if (typeof total !== "number" || !Number.isInteger(total) || total < 0) return "pagination.totalCount missing";
  const mode = b.search?.mode;
  if (typeof mode !== "string") return "search.mode missing";
  const rows: Listing[] = [];
  for (const r of b.data) {
    if (!r || typeof r !== "object" || typeof (r as { _id?: unknown })._id !== "string") return "row without _id";
    rows.push(r as Listing);
  }
  if (rows.length > total) return "more rows than totalCount";
  const place = b.search?.place as { name?: unknown; label?: unknown } | null | undefined;
  return {
    rows,
    total,
    mode,
    placeName: typeof place?.name === "string" ? place.name : undefined,
    placeLabel: typeof place?.label === "string" && place.label ? place.label : undefined,
    corrected: b.search?.corrected === true,
  };
}

export function scopeOf(mode: string, placeAsked: boolean): Scope | null {
  switch (mode) {
    case "place": return "place";
    case "text": return "name";
    case "nearby":
    case "near": return "nearby";
    case "all": return placeAsked ? "unrecognised" : "everywhere";
    default: return null; // an unknown mode means the contract changed
  }
}

export interface CatalogDeps {
  baseUrl: string;
  fetch: typeof fetch;
}

async function getPage(q: CatalogQuery, page: number, deps: CatalogDeps, signal: AbortSignal): Promise<Page | string> {
  // One retry, and only for failures that can be transient. A 4xx is our bug
  // or a contract change — retrying cannot fix it.
  for (let attempt = 0; ; attempt++) {
    let outcome: Page | string;
    let transient = false;
    try {
      const res = await deps.fetch(searchUrl(deps.baseUrl, q, page), {
        headers: { Accept: "application/json" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]),
      });
      transient = res.status >= 500;
      outcome = parsePage(res.status, await res.json().catch(() => null));
    } catch (err) {
      if (signal.aborted) return "aborted";
      transient = true;
      outcome = `network: ${(err as Error).name}`;
    }
    if (typeof outcome !== "string" || !transient || attempt === 1) return outcome;
  }
}

/** Every candidate for the place and dates — or an explicit failure / incomplete. */
export async function fetchCandidates(q: CatalogQuery, deps: CatalogDeps, signal: AbortSignal): Promise<CatalogResult> {
  // The catalogue can change between pages; if the total moves, start over once.
  for (let pass = 0; pass < 2; pass++) {
    const byId = new Map<string, Listing>();
    let first: Page | null = null;
    let moved = false;
    let pages = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const p = await getPage(q, page, deps, signal);
      if (typeof p === "string") return { kind: "failed", why: p };
      pages = page;
      if (!first) first = p;
      else if (p.total !== first.total || p.mode !== first.mode) { moved = true; break; }
      for (const r of p.rows) byId.set(r._id, r);
      if (byId.size >= p.total || p.rows.length === 0) break;
    }
    if (moved && pass === 0) continue;
    if (!first) return { kind: "failed", why: "no page" };
    const scope = scopeOf(first.mode, !!q.place);
    if (!scope) return { kind: "failed", why: `unknown mode ${first.mode}` };
    return {
      kind: "ok",
      scope,
      complete: !moved && byId.size >= first.total,
      rows: [...byId.values()],
      total: first.total,
      placeName: first.placeName,
      placeLabel: first.placeLabel,
      corrected: first.corrected,
      pages,
    };
  }
  return { kind: "failed", why: "catalogue kept changing" };
}
