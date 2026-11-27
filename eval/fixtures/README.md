# Integration-rig fixtures

Synthetic catalogue and availability data for `npm run verify:rag-backend`
(`scripts/verify-rag-backend.ts`): the real search pipeline against a real,
**local** `server.me` and a real, **local** MongoDB. Nothing here is a real
stay, person, address, phone number or URL.

| File | What |
|---|---|
| `generate.ts` | `buildFixtures(today, now)` — pure; returns every document, the code → id map and the availability cases with what the booking rules expect. |
| `seed.ts` | Writes them with the MongoDB driver. Refuses anything but `127.0.0.1`/`localhost` and a database named `rag_rig_*`. |
| `data/fixtures.json` | The documents exactly as last seeded (Extended JSON). |
| `data/seeded.json` | Which local database, which "today", when — the verifier reads this. |

```
# the rig must be running (in-memory MongoDB on 27417 + server.me on 5405)
RAG_RIG_DB_URI="mongodb://127.0.0.1:27417/rag_rig_<suffix>?replicaSet=rs0" npx tsx eval/fixtures/seed.ts [--today=YYYY-MM-DD]
npm run verify:rag-backend
```

`RAG_RIG_DB_URI` is the backend's own `DB_URI`. Seeding is re-runnable (it
empties the fixture collections of that one database, keeps the indexes).
**Re-seed when** the calendar day in India changes, or 30 minutes have passed:
case A3 is a live checkout hold and the backend judges its expiry by the real
clock. The verifier's preflight says so when it is needed.

## Where the shapes come from

Every document has the fields the backend's own code writes (schema defaults
included). After seeding, each one was read back and run through the backend's
Mongoose models (hydration, validation, and a field-by-field comparison with
what Mongoose itself would store) — no difference, apart from the two listings
that lack a field on purpose.

| Documents | Derived from (server.me, `origin/cdrx/server/phase-1`) |
|---|---|
| `listingproperties` | `models/ListingProperty.js` |
| guest booking + its nights | `controllers/bookingLifecycleController.js` `createBooking`, `services/inventory.js` `reserveNights` |
| paid | `services/payments.js` `applyPaymentSuccess` → `inventory.securePermanent` (nights `expiresAt: null`), `models/Payment.js` |
| cancelled + refunded | `cancelCore` → `refundBookingPayment` → `inventory.releaseNights` (no night rows left) |
| host block | `createBooking` with `action: "host"`: `status confirmed`, `paymentStatus paid`, zero quote, nights `kind: "block"`; instants at 18:30Z as the host calendar sends them |
| imported iCal booking | `services/calendarSync/reconcile.js` (new row), `ledger.claimNights` (nights `kind: "ical"`), `icsReader.fingerprint` |
| calendar connection | `services/calendarSync/connections.js` `connect()` + `models/ExternalCalendar.js` |

Left out on purpose: `Booking.listingSnapshot` (optional; "absent on bookings
made before it existed") and listing photos (empty array — no external URL).

Two things keep the rig from ever fetching a calendar: the seed sets the ops
flag `calendar_sync_paused` (`services/calendarSync/flags.js`), and every
connection URL is on `.invalid`, which never resolves.

## Ids

Readable on purpose: a two-character family + a decimal number.
`a1…` users, `b1…` hand-written listings, `b2…` generated listings,
`c1…` bookings, `d1…` payments, `e1…` calendar connections, `f1…` night rows.

84 listings: 80 public (56 in Goa, 12 in Jaipur, 12 in Lucknow) and 4 hidden.

### Jaipur — the requirement matrix (`b100000000000000000001NN`)

| Code | `_id` | What |
|---|---|---|
| J01 | `b10000000000000000000101` | villa, 8 guests, 4 bedrooms, **₹10,000** (budget boundary), pool |
| J02 | `b10000000000000000000102` | villa, 8 guests, 4 bedrooms, **₹10,001** (budget boundary), pool + bbq |
| J03 | `b10000000000000000000103` | villa, 10 guests, 5 bedrooms, ₹9,999, firepit |
| J04 | `b10000000000000000000104` | apartment, 4 guests, 2 bedrooms, ₹4,500, self check-in |
| J05 | `b10000000000000000000105` | apartment, `placeType: room`, 2 guests, ₹2,500, rule `no_pets` |
| J06 | `b10000000000000000000106` | guesthouse, `placeType: private`, 3 guests, ₹3,200 |
| J07 | `b10000000000000000000107` | farmhouse, 12 guests, 6 bedrooms, ₹35,000, pool + bbq + firepit, no wifi |
| **J08** | `b10000000000000000000108` | **`bedrooms` is absent.** villa, 8 guests, ₹9,500, pool |
| **J09** | `b10000000000000000000109` | **`basePrice` is absent.** villa, 6 guests, 3 bedrooms, pool |
| **J10** | `b10000000000000000000110` | **near-duplicate A**: "Saffron Courtyard Haveli", house, ₹7,500, lake |
| **J11** | `b10000000000000000000111` | **near-duplicate B**: same title, house, ₹7,600, lake |
| **J12** | `b10000000000000000000112` | **inactive** (`status: inactive`, `delist: host`); would otherwise match "villa for 8 under 10000 with pool" |
| **J13** | `b10000000000000000000113` | **banned** (`ban: true` while `status: active` — the inconsistent row the public filter guards against) |
| J14 | `b10000000000000000000114` | tent, `placeType: shared`, 2 guests, ₹1,800, firepit, no wifi |

### Goa — the 55+ place

| Code | `_id` | What |
|---|---|---|
| **G-NAME** | `b10000000000000000000201` | "Zephyr Lantern House", Anjuna — the only stay with those title words (stay-name search) |
| **G-INACTIVE** | `b10000000000000000000202` | **inactive** (`delist: admin`), Arpora |
| GG01 … GG55 | `b20000000000000000000001` … `055` | generated with a fixed seed across Anjuna / Arpora / Calangute: every property type and place type, 1–16 guests, 1–7 bedrooms, prices drawn from 1800, 2500, 4500, 7500, 9999, **10000**, **10001**, 15000, 35000, 75000, random amenity sets from the 18 keys |

56 public stays in "Goa" → `limit=50` needs a second page.

### Lucknow — one listing per availability case (`b100000000000000000003NN`)

All alike (house, 4 guests, ₹5,000, instant book). `D+n` = the seeded "today" + n days.
Check-out is exclusive everywhere.

| Code | `_id` | Booking documents | State |
|---|---|---|---|
| A0 | `…300` | — | control, never booked |
| A1 (a) | `…301` | `c1…001`, payment `d1…001` | paid, confirmed, D+10 → D+13; three night rows |
| A2 (b) | `…302` | `c1…002`, `c1…003` | two paid bookings back to back: D+10 → D+12 and D+12 → D+15 |
| A3 (c) | `…303` | `c1…004` | **unexpired** unpaid hold D+10 → D+12 (`expiresAt` = seeding + 30 min) |
| A4 (d) | `…304` | `c1…005` | **expired** unpaid hold D+10 → D+12 (`expiresAt` = seeding − 2 h; the night rows are still there) |
| A5 (e) | `…305` | `c1…006`, payment `d1…006` (refunded) | cancelled; nights released (no rows) |
| A6 (f) | `…306` | `c1…007` | host block, nights D+10 and D+11 |
| A7 (g) | `…307` | `c1…008`, connection `e1…008` | imported iCal booking D+10 → D+13, owns all three nights |
| A8 (g) | `…308` | block `c1…009`, import `c1…010`, connection `e1…010` | **shared night**: the block owns D+11, the import owns D+10 and D+12 |
| A9 (g) | `…309` | cancelled block `c1…011`, import `c1…012`, connection `e1…012` | the shared night's owner was **released**: the import's booking still covers D+11, but no night row exists for it |
| A10 (h) | `…310` | `c1…013` | listing **delisted by its host** (`status: inactive`) after taking a paid booking D+10 → D+12 |
| A11 | `…311` | `c1…014` | paid booking over a month end (last night of a month + first of the next) |
| A12 | `…312` | `c1…015` | paid booking 30 Dec → 2 Jan |

A9 is a state the code can reach, derived by reading it, not reproduced through
the API: `ledger.claimNights` leaves a night already owned by a host block
"shared"; `unblockDates` then cancels the block and deletes its night row; the
import is re-claimed only by a full reconciliation pass or when its feed
changes (`reconcile.js`). Until then the search (night ledger only) and
`/booking/check-dates` (bookings) disagree about that night; `createBooking`
would refuse it (`inventory.importedOverlap`).
