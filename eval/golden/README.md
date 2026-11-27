# Golden conversations for the search assistant

Each line of a `.jsonl` file is one conversation. The evaluation (`npm run eval:rag`) plays it turn by turn and compares what the assistant understood with what is written here. Expected answers are never edited to make a run pass: if the assistant is wrong, the assistant is fixed.

- `dev/` — used while building.
- `heldout/` — written separately, **not read during development**, run only when a release gate is checked.

## Case format

```json
{"id": "hc-001", "cat": "hard", "lang": "en", "turns": [
  {"u": "villas in goa for 8", "state": {"place": "goa", "propertyType": "villa", "guests": {"min": 8}}},
  {"u": "under 10k", "state": {"place": "goa", "propertyType": "villa", "guests": {"min": 8}, "price": {"max": 10000}}}
]}
```

| Field | Meaning |
|---|---|
| `id` | unique |
| `cat` | `hard`, `dates`, `budget`, `multi`, `hinglish`, `hindi`, `unsupported`, `soft`, `intent`, `hostile`, `names` |
| `lang` | `en`, `hinglish`, `hi` |
| `turns[].u` | what the customer types |
| `turns[].state` | the **complete** set of requirements after this turn (not just the change) |
| `turns[].clarify` | `true` when the right response is a clarifying question; the requirements must stay as they were before this turn (`state` then repeats the previous state) |
| `turns[].out` | optional list of acceptable outcome names when the turn is not a search (see below) |

"Today" is fixed at **Wednesday 25 November 2026, India time** for every case.

## Requirement fields (`state`)

| Field | Form | Convention |
|---|---|---|
| `place` | string, lower-case | only the location or stay name, as typed: `"south goa"`, `"anjuna"`, `"casa feliz"`. "near Jaipur" → `"jaipur"`. For Devanagari give alternatives: `"place": ["गोवा", "goa"]` |
| `checkIn`, `checkOut` | `YYYY-MM-DD` | check-out is the departure day. "this weekend" = Sat 28 Nov → Mon 30 Nov. "tomorrow for 2 nights" = 26 → 28 Nov |
| `nights` | integer | only when a length of stay is given with no dates |
| `guests` | `{"min": n}` | adults + children; infants are not counted |
| `bedrooms`, `beds`, `bathrooms` | `{"min": n}`, `{"max": n}`, or both | a plain count ("3 bedrooms", "4BHK") or "at least" → `min`; "exactly 3" → `min` and `max`; "up to 3" → `max` |
| `price` | `{"min": n}`, `{"max": n}`, or both | rupees **per night**. "under / up to / within 10k" → `{"max": 10000}` |
| `propertyType` | `villa`, `apartment`, `hotel`, `tent`, `guesthouse`, `house`, `farmhouse` | "flat" → `apartment`; "homestay", "guest house" → `guesthouse` |
| `placeType` | `entire` or `room` | "private room", "a room" → `room` |
| `amenitiesAll` | list of keys | every one is required |
| `amenitiesAny` | list of keys | "pool or beach" — at least one |
| `amenitiesNone` | list of keys | "no pool", "without TV" |
| `petsAllowed`, `instantBook`, `selfCheckIn` | `true` | |
| `cancellation` | `flexible`, `moderate`, `strict` | |
| `unsupported` | list of short phrases | a **must-have** that fits no field above: `"private pool"`, `"wheelchair access"`, `"sea view"`, `"jacuzzi"`, `"breakfast"`. Never dropped, never weakened. "private pool" → `amenitiesAll: ["pool"]` **and** `unsupported: ["private pool"]` |
| `soft` | list of short phrases | nice-to-haves and vibes: "quiet", "romantic", "ideally a bbq" |

Amenity keys (the only ones that exist): `wifi`, `free-parking`, `air-conditioning`, `kitchen`, `tv`, `fire-extinguisher`, `workspace`, `pool`, `first-aid`, `washing`, `outdoor-dining`, `bbq`, `lake`, `beach`, `smoke-alarm`, `firepit`, `patio`, `pool-table`.

Order inside lists does not matter. `unsupported` is matched loosely (same number of items, each sharing a meaningful word). `soft` is not scored except that a soft wish must not appear as a hard requirement.

## Conventions for follow-up turns

| The customer says | Expected |
|---|---|
| "cheaper", "something cheaper", "thoda sasta" — no amount | no requirement changes; `soft` gains "cheaper" |
| "above 10k", "at least 10k", "10k se zyada" | `price: {"min": 10000}` (an earlier ceiling stays) |
| "at least 5000" after "under 10000" | `price: {"min": 5000, "max": 10000}` |
| "make it 8000", "under 8000" after an earlier ceiling | the ceiling is replaced |
| "any budget", "budget no issue", "forget the budget" | `price` is removed |
| "4 to 6 people" | `guests: {"min": 4, "max": 6}` (the stay must sleep 6) |
| "pool not needed", "pool nahi chahiye", "forget the pool" after a pool was required | the pool requirement is removed — **not** an exclusion |
| "without a pool", "bina pool ke", "no pool" as a fresh requirement | `amenitiesNone: ["pool"]` |
| "near the beach", "sea view", "lake view", "5 minutes from Baga" | `unsupported` (a view or a distance is not an amenity) |
| "beach access", "beachfront", "on the beach" | `amenitiesAll: ["beach"]` |
| dates arrive after "for 3 nights" | `checkIn` / `checkOut` are set and `nights` is dropped |
| "actually Jaipur", "no, in North Goa" | `place` is replaced; everything else stays |
| "start over", "new search" | `{}` with `out: ["reset"]` |
| "any type is fine", "villa nahi, kuch bhi chalega" | `propertyType` is removed |
| a question about a stay already shown ("does the second one have parking?") | the requirements do not change; `out: ["info"]` (or `["which_stay"]` when nothing was shown) |

## Finer points (each one was found ambiguous by a case author)

| Situation | Expected |
|---|---|
| a budget with no qualifier ("budget 10k") | a ceiling: `price: {"max": 10000}` |
| "X not needed" / "X nahi chahiye" when X was **never** asked for | an exclusion: `amenitiesNone: ["x"]` |
| a bare "tonight" / "tomorrow" / "kal" with no length | one night |
| "N din" / "N days" with no nights | do not write such cases — say nights ("3 din 2 raat" → 2 nights) |
| a date earlier in the **current** month ("20 nov" on 25 Nov) | in the past → clarifying question |
| a month earlier than the current one, no year ("5 to 8 january") | next year |
| "forget the dates", "dates are flexible" | `checkIn`, `checkOut` and `nights` removed |
| "anywhere in Goa is fine" after a town | `place: "goa"` |
| "ghar", "jagah", "place", "stay" | no `propertyType` (a generic word); "poora ghar" / "entire house" → `placeType: "entire"` |
| "kamra", "a room" | `placeType: "room"`. Do not write "2 kamre"-style cases (rooms vs bedrooms is unclear) |
| an insisted vibe ("must be quiet") | `unsupported` — it is a must-have and no field can check it |
| "bonfire" → `firepit`; "lakeside" → `lake`; "balcony", "garden", "terrace" | the first two are amenity keys; the rest are `unsupported` |
| "one more person is joining", "2 couples" | the arithmetic: guests + 1; 4 guests |
| a list that becomes empty | the field is omitted (not `[]`) |
| a must-have in Hindi with no field | write the `unsupported` phrase in the customer's own script |
| a message that needs a clarifying question **and** also contains valid requirements | nothing from that message is applied — the state stays exactly as it was |
| a turn that changes nothing and is not a question ("ok", "yes" with nothing pending) | the state is unchanged; any outcome is accepted (give `out` only when one specific outcome is required) |

## Cases that must end in a clarifying question (`"clarify": true`)

- a budget that is not per night: "5,000 per person", "50k in total"
- dates in the past, check-out not after check-in, only one date, an impossible date
- contradictory requirements ("at least 5 bedrooms, max 2")

## Outcomes for non-search turns (`out`)

`greeting`, `thanks`, `reset`, `policy`, `support` (the customer's own booking), `travel_off` (general travel advice), `info` (a question about, or comparison of, stays already shown), `which_stay` (such a question when it is unclear which stay is meant), `other`.
A turn with `out` and no `state` leaves the requirements as they were.
A turn that changes the search is always a search, even if it also asks something.
