# Evaluating the search assistant

| Path | What it is |
|---|---|
| `golden/dev/` | Conversations used while building (152 conversations, 290 turns). Format and conventions: `golden/README.md`. |
| `golden/heldout/` | First independent set (100 / 199). **Retired as the release gate** on 2026-11-26: its totals were looked at while the code was being changed. Still never opened. |
| `golden/reg-h3/`, `golden/reg-h4/` | The former `heldout3` (80 / 174) and `heldout4` (80 / 176). **Retired 2026-11-27 by the owner and opened as development and regression data** after candidates 1 and 2 failed them. Their sealed originals, recordings and gate reports are archived unchanged in `archive/2026-11-27-heldout3-heldout4/` (`SHA256SUMS`; the cases match the sealed fingerprints). Recordings moved with them (`recordings/reg-h3`, `recordings/reg-h4`). Replayed by `scripts/regress.sh`. |
| `golden/heldout5/` | Sealed set (80 / 179, fingerprint `reports/heldout5-fingerprint.txt`), **not used as a gate**: its author's context automatically included this repository's `CLAUDE.md`, which at that moment described candidate 3's fixes with example phrasings. Never opened; kept sealed. |
| `golden/heldout6/` | Fresh sealed set written by an independent author from `golden/README.md` only, after those phrasings were removed from `CLAUDE.md` (fingerprint `reports/heldout6-fingerprint.txt`). The release gate for candidate 3 (failed 2026-11-27: multi-turn 80.8 %, Hindi / Hinglish 82.3 %). **Still sealed** (owner decision): only its totals and wrong-turn origins are used. |
| `golden/dev-fresh/` | 60 / 166, written 2026-11-27 by an independent author from `golden/README.md` only, for an unbiased old-vs-new comparison of the follow-up redesign (reg-h3 / reg-h4 favour candidate 3, which was fixed against them). Groups by id: 001-020 mixed-language follow-ups, 021-030 removals / replacements, 031-038 new search mid-chat, 039-042 place-only change, 043-052 long conversations, 053-060 other turn kinds. Development data (not sealed). |
| `golden/heldout7/` | Sealed set (80 / 185, fingerprint `reports/heldout7-fingerprint.txt`) written by an independent author from `golden/README.md` only. **The release gate for the follow-up redesign.** Never opened; totals only. |
| `golden/heldout2/` | Fresh independent set (80 / 156), written by a separate author from `golden/README.md` only. **The release gate. Do not open it while developing.** Reports print totals only. |
| `reports/inventory-*.md` | Case inventories with scoring criteria. Held-out inventories list ids, categories and counts, never questions. `npm run eval:rag -- --inventory --set <set>` |
| `recordings/<set>/<chain>__<run>.json` | Every model answer, saved the moment it arrives, keyed by the exact prompt and input. The checkpoint for resuming and the input for free replays. |
| `contract/` | Real responses of `server.me`'s public search (`node scripts/capture-search-contract.mjs`). `npm run verify:rag` reads them. |
| `fixtures/` | Synthetic listings, bookings, holds, blocks and imported calendars for the isolated backend rig (`npm run verify:rag-backend`, see `fixtures/README.md`). |
| `ranking/` | Phase 3 ranking benchmark: `REPORT.md` and its data (`npm run bench:ranking`). |
| `baseline/v1.ts` | The pre-pipeline retrieval logic, verbatim, for measuring the old behaviour. Not live code. |

```bash
npm run verify:rag                                          # pure checks, seconds, free: after every edit under src/lib/rag
npm run eval:rag                                            # replay a recording: proves the code, says nothing about a model
npm run eval:rag -- --live --run r1                         # live, default chain, one repetition (resumes from its recording)
npm run eval:rag -- --live --model groq:openai/gpt-oss-120b --every 3 --run b3   # benchmark one model on a fixed third of dev
npm run eval:rag -- --live --set heldout2 --run r1          # release gate; totals only
npm run eval:rag -- --summary r1,r2,r3                      # variability across repetitions (offline)
npm run eval:rag -- --only hg-06 --live                     # one dev conversation, verbose
bash scripts/eval-batches.sh <name> <pause-s> <max-batches> -- <eval:rag args>   # run to completion across quota windows
npm run eval:rag -- --live --chain A,B --chain-hinglish B,A --run r1                  # language routing (LLM_CHAIN_HINGLISH)
npm run eval:rag -- --compose --chain A,B --chain-hinglish B,A --run hg1 [--unavailable A]   # offline: replay routing from single-model recordings; --unavailable = that model out of quota
npx tsx scripts/compare-models.ts --run hg1 --a <model> --b <model> [--only ids]   # paired benchmark on identical case ids: missing, refused, clarified, latency
```

## Free tiers, quota and resuming

Spending limit is ₹0: only free tiers of the existing Groq and Gemini keys are used, and nothing switches to a paid model or endpoint.

- Every call is recorded as it arrives, so a run stopped by quota, a budget (`--budget N`) or Ctrl-C resumes with the same command and never repeats a completed call. Exit code 3 means "incomplete, resume"; `eval-batches.sh` waits and resumes until the run completes.
- When a provider answers 429 the runner waits as long as it asks (bounded by `--max-wait`), then stops the batch after repeated failures instead of burning the window.
- A turn whose model call failed is a **provider error**, reported on its own line and never scored as a wrong answer.
- Routine regression checks use replays and `verify:rag`; live runs are kept for benchmarks and the release gate.

## Release gates

| Metric | Gate |
|---|---:|
| Mandatory-requirement violations in shown cards | 0 |
| Unverified requirement shown as satisfied | 0 |
| Technical failure or incomplete search worded as "no stays" | 0 |
| Multi-turn constraint accuracy | ≥ 98 % |
| Supported Hindi / Hinglish extraction | ≥ 95 % |
| No-match accuracy | ≥ 98 % |
| Ordinary search p95 | ≤ 3.5 s |

Measured on `heldout2`, live, three independent repetitions on one frozen configuration (the production chain, `--chain groq:openai/gpt-oss-120b,groq:openai/gpt-oss-20b --live-catalog`, runs `r1`, `r2`, `r3`). A run recorded under a different chain is never resumed into these (the chain is part of every recording key). If a gate is missed the release waits; expected answers are never edited to pass.

How the newer gate lines are measured:

- **No-match accuracy**: search turns whose requirements were read right and whose candidate set was complete, where no fetched stay meets every requirement (and none is "possible"). Correct when the reply is a "no stays" outcome (`no_match`, `nearby`, `nearby_none`, `unrecognised_place`, `name_not_found`) with no card labelled a match. Reported beside it: "no stays" said although a stay met every requirement (must be 0).
- **End-to-end p95**: with `--live-catalog`, each search turn's wall time (live model + live search API), excluding the runner's own pacing and quota waits; kept per turn in `recordings/<set>/<chain>__<run>.timing.json` so resumed batches keep earlier timings.
- **Provider share**: which model answered each turn, how often the fallback was used, and turns with no answer at all (provider failures, never scored as wrong).

Each report separates: task completion (turn fully correct), unnecessary clarification or refusal, missed clarification, mandatory-requirement violations, incomplete candidate sets, results by category and language, and where each wrong turn went wrong:

| Origin | Meaning |
|---|---|
| model | the model's reading was wrong and the checks let it through |
| model-caught | the reading was wrong and a check refused it (a clarifying question instead of a wrong search) |
| checks | the reading was right and a check refused it (an unnecessary clarification) |
| merge | code changed a right reading |
| cascade | the turn was right but an earlier turn's error carried over |
| routing | a fast path or intent routing chose the wrong kind of reply |
| catalog | the search API failed or was incomplete |

## Misreadings seen live, and the guard for each

Each row was a failing turn in `golden/dev` on a live run. The guard is deterministic code, checked in `verify:rag`.

| Message | The problem | Guard |
|---|---|---|
| "3 bedroom villa in morjim" | read as exactly 3 bedrooms | `normaliseExact`: exact only when the customer says "exactly / only / sirf" |
| "we are 6 people" | guests {min 6, max 6} counted 6 twice → needless question | `normaliseExact` collapses an equal guest range; `extractedNumbers` counts "exactly 4" once |
| "private room in lucknow", "pet friendly villa" | also listed as an unsupported must-have | `coveredByField`: an unsupported label fully covered by one real field is an echo |
| "pool nahi chahiye" after asking for a pool | exclude stays with a pool | `guards.ts`: negating something that was required removes it, unless "without / bina" |
| "30 dec to 2 jan", "5 to 8 january" | a year already past | `repairYears` (never for a date earlier in the current month, never when a year is typed) |
| "this weekend", "kal se 2 raat" | wrong start day | `repairRelativeDates`: one relative anchor sets the start day by the calendar |
| "make it 4 nights" with dates set | moved check-in, or kept the old length | `repairLength`: keeps check-in, check-out = check-in + N |
| "we are 8 now" (dates already set) | echoed "nights: 3" | `stripRestated` |
| "pool not needed" (pool + wifi required) | dropped every amenity | an amenity removal is narrowed to the amenities named |
| "5 hazaar se zyada, 9 hazaar se kam", "12 हज़ार से ज़्यादा नहीं" | right reading refused (the direction word comes after the amount in Hindi) | `boundDirection` reads Hindi postpositions after the amount |
| "3 log (2 bade aur ek 7 saal ka baccha)" | an age and a breakdown counted as unused numbers | ages are set aside in `numbersIn`; only numbers written as the breakdown ("2 bade", "ek … baccha") are forgiven, never a leftover that happens to add up |
| "budget ka abhi pata nahi" | "pata nahi" (don't know) read as a negation | `hasNegation`, `negatedAmenities` ignore "pata / maloom nahi" |
| "बजट हटा दो", "reset pls", "let's start fresh" | removal or reset not recognised | Devanagari removal words; wider reset pattern |
| "not more than 8000", "zyada se zyada 8000", "5000+", "10k max" | direction misjudged | direction words are whole words, negated forms come first, and the amount must sit right next to the word |
| `{"set": {"nights": 4}, "unset": ["checkIn", "checkOut"]}`, `{"remove": ["wifi"]}` | a correct reading in the wrong place was lost or refused | fields are read from either place (lists joined, conflicting values refused); unset of check-in/check-out means the dates; no intent + only search fields = a search (never when it points at a stay) |
| `reset: true` on a first message | refused as an unrequested removal | a reset with nothing to reset is ignored |
| "pahad ka view ho to accha" | a nice-to-have made a must-have | moved to soft only when that label is named once, right next to "ho to accha / would be nice / ideally", with no "warna / otherwise" |
| "jaipur ke paas", "teen raat" | place with the Hindi "near"; a typed length left out | the Hindi suffix is dropped from the place; a single typed length is kept when no dates exist (not for ranges or negations) |
| "5 din ke liye" with dates set | new length stored, old dates kept silently | a clarifying question, unless the customer is dropping the dates ("forget the dates", "flexible") |
| an injection attempt answered with `{}` | "try again" (a technical-failure reply) | an unusable but valid answer gets "I'm not sure I understood" |

Rules tried and removed after independent review (they made things worse): adding "private pool" by code when the model kept only "pool" (it also fired on "no need for a private pool"); cutting an English "near / around / close to" prefix from a place (it cut stay names); tying "exactly" to its number (it missed "exactly three" and showed bigger stays as matches; any exact cue now keeps an exact count, which can only hide stays).

## Model benchmark (free tiers, ₹0)

Fixed third of the dev set (`--every 3`: 51 conversations, about 100 turns), one model at a time, no fallback. Results and the chosen chain are in `reports/` (`b3-*.txt`) and in the completion report.

Provider facts measured with the development keys (2026-11-25/26):

- Groq: about 1,000 requests and 200,000 tokens a day **per model**, 8,000 tokens a minute. One understanding call is about 1,450 input and 100–250 output tokens, so about 120 calls per model per day. Terms: inputs not used for training, not retained by default.
- Gemini unpaid tier: 500 requests a day per model; `gemini-flash-lite-latest` and `gemini-3.5-flash-lite` share one bucket; `gemini-3.1-flash-lite` often 503; `gemini-2.5-flash-lite` 404 for new keys. Terms: unpaid inputs may be reviewed by people and used to improve Google products, so Gemini is not used for customer traffic.
- `openai/gpt-oss-20b` / `-120b` need `reasoning_effort: "low"` for JSON mode.
