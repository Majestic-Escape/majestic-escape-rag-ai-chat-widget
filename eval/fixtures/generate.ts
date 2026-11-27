// Synthetic catalogue + availability fixtures for the backend integration rig
// (scripts/verify-rag-backend.ts). Pure: `buildFixtures(today, now)` returns the
// documents; eval/fixtures/seed.ts writes them into a LOCAL database.
//
// Every document is shaped as server.me (origin/cdrx/server/phase-1) writes it —
// the field lists below were derived from the code that creates each one:
//   listings      models/ListingProperty.js (schema defaults included)
//   guest booking controllers/bookingLifecycleController.js createBooking
//   paid          services/payments.js applyPaymentSuccess + inventory.securePermanent
//   refund/cancel services/payments.js refundBookingPayment + cancelCore (nights released)
//   host block    createBooking with action "host" (18:30Z instants, kind "block")
//   iCal import   services/calendarSync/reconcile.js (new row) + ledger.claimNights
//   connection    services/calendarSync/connections.js connect()
// No real person, address, phone number or URL appears anywhere.

import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { AMENITY_KEYS } from "../../src/lib/rag/types";

const DAY_MS = 86_400_000;
export const addDays = (d: string, n: number): string =>
  new Date(Date.parse(`${d}T00:00:00.000Z`) + n * DAY_MS).toISOString().slice(0, 10);
const utc = (d: string) => new Date(`${d}T00:00:00.000Z`);
/** 24-hex id: a two-letter family prefix + a decimal number, so ids are readable. */
const oid = (prefix: string, n: number) => new ObjectId(prefix + String(n).padStart(24 - prefix.length, "0"));
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export type Doc = Record<string, unknown> & { _id: ObjectId };

// Seeded generator (same LCG as scripts/verify-rag.ts): the catalogue is reproducible.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// Places the backend's gazetteer knows (utils/places resolveQuery, checked on the rig).
const PLACES = {
  anjuna: { city: "Anjuna", district: "North Goa", state: "Goa", pincode: "403509", lat: 15.5801, lng: 73.7449 },
  arpora: { city: "Arpora", district: "North Goa", state: "Goa", pincode: "403516", lat: 15.5469, lng: 73.7572 },
  calangute: { city: "Calangute", district: "North Goa", state: "Goa", pincode: "403516", lat: 15.5439, lng: 73.7553 },
  jaipur: { city: "Jaipur", district: "Jaipur", state: "Rajasthan", pincode: "302001", lat: 26.9196, lng: 75.7878 },
  lucknow: { city: "Lucknow", district: "Lucknow", state: "Uttar Pradesh", pincode: "226001", lat: 26.8393, lng: 80.9231 },
} as const;
type PlaceKey = keyof typeof PLACES;

const HOST_ID = oid("a1", 1);
const GUEST_ID = oid("a1", 2);
const HOST_EMAIL = "rig-host@example.invalid";

interface ListingSpec {
  n: number; // id number within the "b1" family
  code: string;
  place: PlaceKey;
  title: string;
  propertyType: string;
  placeType?: "entire" | "room" | "private" | "shared";
  guests: number;
  bedrooms?: number; // undefined = the field is absent in the document
  beds: number;
  bathrooms: number;
  basePrice?: number; // undefined = the field is absent in the document
  amenities: string[];
  instantBook?: boolean;
  cancellation?: "moderate" | "flexible" | "strict";
  selectedRules?: string[];
  occupancy?: string[];
  status?: "active" | "inactive";
  ban?: boolean;
  delist?: "host" | "admin";
}

function listingDoc(s: ListingSpec, id: ObjectId, order: number, today: string): Doc {
  const p = PLACES[s.place];
  const created = new Date(utc(today).getTime() - 400 * DAY_MS + order * 3_600_000); // distinct → a stable "newest first"
  const cancel = s.cancellation ?? "moderate";
  const doc: Doc = {
    _id: id,
    propertyType: s.propertyType,
    placeType: s.placeType ?? "entire",
    title: s.title,
    description: "Synthetic listing for the integration rig. Not a real stay.",
    occupancy: s.occupancy ?? [],
    ban: s.ban ?? false,
    guests: s.guests,
    ...(s.bedrooms !== undefined ? { bedrooms: s.bedrooms } : {}),
    beds: s.beds,
    bathrooms: s.bathrooms,
    ...(s.delist ? { delist: s.delist } : {}),
    photos: [],
    address: {
      street: `${order + 1} Quarry Bend`,
      district: p.district,
      city: p.city,
      state: p.state,
      pincode: p.pincode,
      country: "India - IN",
      latitude: p.lat + ((order % 7) - 3) * 0.0006,
      longitude: p.lng + ((order % 5) - 2) * 0.0006,
    },
    validRegistrationNo: false,
    bankDetails: false,
    bathroomTypes: { private: 0, shared: 0, dedicated: 0 },
    amenities: s.amenities,
    ...(s.basePrice !== undefined ? { basePrice: s.basePrice } : {}),
    discounts: [],
    bookingType: { manual: !s.instantBook, instantBook: !!s.instantBook, flashBook: false },
    cancellationType: { moderate: cancel === "moderate", flexible: cancel === "flexible", strict: cancel === "strict" },
    status: s.status ?? "active",
    host: HOST_ID,
    hostEmail: HOST_EMAIL,
    checkinTime: "14",
    checkoutTime: "11",
    selectedRules: s.selectedRules ?? [],
    customRules: [],
    createdAt: created,
    kycStatus: "completed",
    averageRating: 0,
    reviewCount: 0,
    updatedAt: created,
    __v: 0,
  };
  return doc;
}

// ── the hand-written listings ────────────────────────────────────────────────

const JAIPUR: ListingSpec[] = [
  { n: 101, code: "J01", place: "jaipur", title: "Indigo Stepwell Villa", propertyType: "villa", guests: 8, bedrooms: 4, beds: 5, bathrooms: 4, basePrice: 10000, amenities: ["wifi", "pool", "kitchen", "air-conditioning", "free-parking"], instantBook: true },
  { n: 102, code: "J02", place: "jaipur", title: "Ochre Jharokha Villa", propertyType: "villa", guests: 8, bedrooms: 4, beds: 4, bathrooms: 3, basePrice: 10001, amenities: ["wifi", "pool", "bbq"] },
  { n: 103, code: "J03", place: "jaipur", title: "Teal Baradari Villa", propertyType: "villa", guests: 10, bedrooms: 5, beds: 6, bathrooms: 5, basePrice: 9999, amenities: ["wifi", "kitchen", "firepit", "patio"], cancellation: "flexible" },
  { n: 104, code: "J04", place: "jaipur", title: "Maroon Chowk Apartment", propertyType: "apartment", guests: 4, bedrooms: 2, beds: 2, bathrooms: 2, basePrice: 4500, amenities: ["wifi", "tv", "workspace", "washing"], occupancy: ["self-check-in"] },
  { n: 105, code: "J05", place: "jaipur", title: "Slate Terrace Room", propertyType: "apartment", placeType: "room", guests: 2, bedrooms: 1, beds: 1, bathrooms: 1, basePrice: 2500, amenities: ["wifi", "air-conditioning"], selectedRules: ["no_pets"] },
  { n: 106, code: "J06", place: "jaipur", title: "Copper Lantern Guesthouse", propertyType: "guesthouse", placeType: "private", guests: 3, bedrooms: 1, beds: 2, bathrooms: 1, basePrice: 3200, amenities: ["wifi", "kitchen", "tv"], cancellation: "strict" },
  { n: 107, code: "J07", place: "jaipur", title: "Mustard Field Farmhouse", propertyType: "farmhouse", guests: 12, bedrooms: 6, beds: 8, bathrooms: 6, basePrice: 35000, amenities: ["pool", "bbq", "firepit", "outdoor-dining", "free-parking", "pool-table"] },
  // SPECIAL: `bedrooms` is absent from the document.
  { n: 108, code: "J08", place: "jaipur", title: "Pearl Arcade Villa", propertyType: "villa", guests: 8, beds: 4, bathrooms: 3, basePrice: 9500, amenities: ["wifi", "pool", "kitchen"] },
  // SPECIAL: `basePrice` is absent from the document.
  { n: 109, code: "J09", place: "jaipur", title: "Jade Pavilion Villa", propertyType: "villa", guests: 6, bedrooms: 3, beds: 3, bathrooms: 3, amenities: ["wifi", "pool"] },
  // SPECIAL: two near-duplicates with the same title (different id, price, one amenity).
  { n: 110, code: "J10", place: "jaipur", title: "Saffron Courtyard Haveli", propertyType: "house", guests: 6, bedrooms: 3, beds: 4, bathrooms: 2, basePrice: 7500, amenities: ["wifi", "lake", "smoke-alarm", "first-aid", "fire-extinguisher"] },
  { n: 111, code: "J11", place: "jaipur", title: "Saffron Courtyard Haveli", propertyType: "house", guests: 6, bedrooms: 3, beds: 4, bathrooms: 2, basePrice: 7600, amenities: ["wifi", "lake", "smoke-alarm", "first-aid"] },
  // SPECIAL: inactive (would otherwise match "villa for 8 under 10000 with a pool").
  { n: 112, code: "J12", place: "jaipur", title: "Hidden Inactive Villa", propertyType: "villa", guests: 8, bedrooms: 4, beds: 4, bathrooms: 4, basePrice: 8000, amenities: ["wifi", "pool", "kitchen"], status: "inactive", delist: "host" },
  // SPECIAL: banned while still "active" — the inconsistent row publicListingFilter guards against.
  { n: 113, code: "J13", place: "jaipur", title: "Hidden Banned Villa", propertyType: "villa", guests: 8, bedrooms: 4, beds: 4, bathrooms: 4, basePrice: 8200, amenities: ["pool", "kitchen"], ban: true },
  { n: 114, code: "J14", place: "jaipur", title: "Dune Canvas Tent", propertyType: "tent", placeType: "shared", guests: 2, bedrooms: 1, beds: 2, bathrooms: 1, basePrice: 1800, amenities: ["firepit", "outdoor-dining"] },
];

const GOA_HAND: ListingSpec[] = [
  // SPECIAL: the only listing with these title words — the stay-name ("text") search target.
  { n: 201, code: "G-NAME", place: "anjuna", title: "Zephyr Lantern House", propertyType: "villa", guests: 6, bedrooms: 3, beds: 3, bathrooms: 3, basePrice: 12000, amenities: ["wifi", "pool", "beach"] },
  // SPECIAL: inactive, in the 55+ place.
  { n: 202, code: "G-INACTIVE", place: "arpora", title: "Hidden Inactive Cottage", propertyType: "house", guests: 4, bedrooms: 2, beds: 2, bathrooms: 2, basePrice: 5000, amenities: ["wifi"], status: "inactive", delist: "admin" },
];

// One listing per availability case, all alike, all in Lucknow.
const AVAILABILITY_CODES = [
  ["A0", "Availability Control Free"],
  ["A1", "Availability Paid Booking"],
  ["A2", "Availability Back To Back"],
  ["A3", "Availability Live Hold"],
  ["A4", "Availability Expired Hold"],
  ["A5", "Availability Cancelled Booking"],
  ["A6", "Availability Host Block"],
  ["A7", "Availability Imported Calendar"],
  ["A8", "Availability Imported Shared Night"],
  ["A9", "Availability Imported Released Share"],
  ["A10", "Availability Deactivated Later"],
  ["A11", "Availability Month End"],
  ["A12", "Availability Year End"],
] as const;
const LUCKNOW: ListingSpec[] = AVAILABILITY_CODES.map(([code, title], i) => ({
  n: 300 + i, code, place: "lucknow", title, propertyType: "house", guests: 4, bedrooms: 2, beds: 2, bathrooms: 2, basePrice: 5000,
  amenities: ["wifi", "kitchen"], instantBook: true,
  ...(code === "A10" ? { status: "inactive" as const, delist: "host" as const } : {}),
}));

// 55 generated Goa listings: enough to force a second page at limit=50.
const ADJ = ["Amber", "Cobalt", "Juniper", "Marigold", "Opal", "Russet", "Sable", "Tamarind", "Umber", "Vetiver", "Willow"];
const NOUN = ["Verandah", "Orchard", "Lagoon", "Hammock", "Courtyard", "Lighthouse", "Meadow", "Terrace"];
const TYPES = ["villa", "apartment", "guesthouse", "house", "farmhouse", "tent", "hotel"];
const PRICES = [1800, 2500, 4500, 7500, 9999, 10000, 10001, 15000, 35000, 75000];
function generatedGoa(): ListingSpec[] {
  const r = rng(20261126);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const out: ListingSpec[] = [];
  for (let i = 1; i <= 55; i++) {
    out.push({
      n: i,
      code: `GG${String(i).padStart(2, "0")}`,
      place: (["anjuna", "arpora", "calangute"] as const)[i % 3]!,
      title: `${ADJ[i % ADJ.length]} ${NOUN[i % NOUN.length]} No ${i}`,
      propertyType: pick(TYPES),
      placeType: pick(["entire", "entire", "entire", "room", "private", "shared"] as const),
      guests: 1 + Math.floor(r() * 16),
      bedrooms: 1 + Math.floor(r() * 7),
      beds: 1 + Math.floor(r() * 9),
      bathrooms: 1 + Math.floor(r() * 6),
      basePrice: pick(PRICES),
      amenities: AMENITY_KEYS.filter(() => r() < 0.3),
      instantBook: r() < 0.3,
      cancellation: pick(["moderate", "flexible", "strict"] as const),
      selectedRules: r() < 0.3 ? ["no_pets"] : r() < 0.3 ? ["no_smoking"] : [],
      occupancy: r() < 0.25 ? ["self-check-in"] : [],
    });
  }
  return out;
}

// ── bookings ────────────────────────────────────────────────────────────────

// services/pricing.js quoteStay, step for step.
function quoteStay(basePrice: number, nights: number) {
  const subTotal = basePrice * nights;
  const serviceFee = Math.round(subTotal * 0.12);
  const gst = basePrice <= 7500 ? Math.round(subTotal * 0.05) : Math.round(subTotal * 0.18);
  const total = subTotal + serviceFee + gst;
  const paise = (x: number) => Math.round(x * 100);
  return { basePrice, nights, subTotal, total, subTotalPaise: paise(subTotal), serviceFeePaise: paise(serviceFee), gstPaise: paise(gst), totalPaise: paise(total) };
}

const NOTIFICATIONS = () => ({ paidAt: null, confirmedAt: null, attentionAt: null, sent: [] });
const ATTENTION = { needsAttention: null, attentionDetails: null, attentionResolvedAt: null, attentionResolution: null };

export interface AvailabilityRange {
  label: string;
  from: string;
  to: string;
  /** What the booking rules say: true = every night of the range is free for a new stay. */
  free: boolean;
}
export interface AvailabilityCase {
  code: string;
  listingId: string;
  what: string;
  ranges: AvailabilityRange[];
}

export interface Fixtures {
  today: string;
  now: Date;
  users: Doc[];
  listings: Doc[];
  bookings: Doc[];
  nights: Doc[];
  payments: Doc[];
  calendars: Doc[];
  opsflags: Record<string, unknown>[];
  /** listing code → id (hex). */
  ids: Record<string, string>;
  cases: AvailabilityCase[];
}

/**
 * @param today the fixed calendar "today" (YYYY-MM-DD, India) every stay date is relative to
 * @param now   the real instant of seeding — hold expiries are judged by the backend's own clock
 */
export function buildFixtures(today: string, now: Date): Fixtures {
  const D = (n: number) => addDays(today, n);
  const listings: Doc[] = [];
  const ids: Record<string, string> = {};
  let order = 0;
  for (const s of [...JAIPUR, ...GOA_HAND, ...LUCKNOW]) {
    const id = oid("b1", s.n);
    ids[s.code] = id.toHexString();
    listings.push(listingDoc(s, id, order++, today));
  }
  for (const s of generatedGoa()) {
    const id = oid("b2", s.n);
    ids[s.code] = id.toHexString();
    listings.push(listingDoc(s, id, order++, today));
  }

  const person = (id: ObjectId, firstName: string, email: string, phone: string, role: "user" | "host"): Doc => ({
    _id: id, firstName, lastName: "Fixture", email, tokenVersion: 0, listingFence: 0, languages: [], isVerified: true, otpRetries: 0,
    phoneNumber: phone, countryCode: "+91", role, status: { active: true, banned: false }, bank: false, kyc: false,
    address: { geoLocation: { type: "Point" } },
    verification: { emailVerified: true, phoneVerified: false, idVerified: false, socialAccounts: [] },
    preferences: { language: "en-IN", currency: "INR", theme: "light", notificationSettings: { email: true, sms: true, push: true } },
    averageRating: 0, reviewCount: 0, avgPropertyRating: 0, propertyReviewCount: 0, wishlist: [], bookings: [],
    createdAt: now, updatedAt: now, __v: 0,
  });
  const users = [
    person(HOST_ID, "Righost", HOST_EMAIL, "0000000001", "host"),
    person(GUEST_ID, "Rigguest", "rig-guest@example.invalid", "0000000002", "user"),
  ];

  const bookings: Doc[] = [];
  const nights: Doc[] = [];
  const payments: Doc[] = [];
  const calendars: Doc[] = [];
  let seq = 0;
  let nightSeq = 0;
  const L = (code: string) => new ObjectId(ids[code]!);

  const addNights = (propertyId: ObjectId, bookingId: ObjectId, days: string[], kind: "booking" | "block" | "ical", expiresAt: Date | null, createdAt: Date) => {
    for (const d of days) nights.push({ _id: oid("f1", ++nightSeq), propertyId, date: utc(d), bookingId, kind, expiresAt, createdAt, __v: 0 });
  };
  const span = (from: string, to: string) => {
    const out: string[] = [];
    for (let d = from; d < to; d = addDays(d, 1)) out.push(d);
    return out;
  };

  /** A guest booking as createBooking writes it, then moved to the given state. */
  function guestBooking(code: string, from: string, to: string, state: "paid" | "hold" | "expired_hold" | "cancelled"): ObjectId {
    const _id = oid("c1", ++seq);
    const propertyId = L(code);
    const days = span(from, to);
    const q = quoteStay(5000, days.length);
    const created = new Date(now.getTime() - (state === "expired_hold" ? 150 : 60) * 60_000);
    const holdExpiresAt = state === "hold" ? new Date(now.getTime() + 30 * 60_000) : state === "expired_hold" ? new Date(now.getTime() - 120 * 60_000) : null;
    const paymentId = state === "paid" || state === "cancelled" ? oid("d1", seq) : undefined;
    bookings.push({
      _id, userId: GUEST_ID, source: "local", action: "user", sourceId: null, propertyId,
      ...(paymentId ? { payment: paymentId } : {}),
      hostId: HOST_ID, checkIn: utc(from), checkOut: utc(to), price: q.total, subTotal: q.subTotal, currency: "INR",
      status: state === "paid" ? "confirmed" : state === "cancelled" ? "cancelled" : "pending",
      paymentStatus: state === "paid" ? "paid" : state === "cancelled" ? "refunded" : "unpaid",
      flag: false, cancellationPolicy: "moderate", guests: 2, adults: 2, children: 0, infants: 0, nights: days.length,
      guestData: { adults: [{ name: "Rigguest Fixture", age: 30, _id: oid("c2", seq) }], children: [] },
      reviewed: false, hostReviewed: false,
      ...(state === "cancelled" ? { refundAmount: q.total } : {}),
      quote: { basePrice: q.basePrice, nights: q.nights, subTotalPaise: q.subTotalPaise, serviceFeePaise: q.serviceFeePaise, gstPaise: q.gstPaise, totalPaise: q.totalPaise, currency: "INR" },
      holdExpiresAt, notifications: NOTIFICATIONS(), ...ATTENTION, createdAt: created, updatedAt: created, __v: 0,
    });
    if (paymentId) {
      const refunded = state === "cancelled";
      payments.push({
        _id: paymentId, orderId: `order_rigfixture${seq}`, paymentId: `pay_rigfixture${seq}`, amount: q.totalPaise, currency: "INR",
        status: refunded ? "refunded" : "paid", bookingId: _id, propertyId, paymentType: refunded ? "refunded" : "pay-in", paymentMethod: "upi",
        customerDetails: { name: "Rigguest Fixture", email: "rig-guest@example.invalid", contact: "0000000002" },
        razorpayStatus: "captured", paidAt: created,
        refundId: refunded ? `rfnd_rigfixture${seq}` : null, refundAmount: refunded ? q.totalPaise : null,
        refundInitiatedAt: refunded ? created : null, refundedAt: refunded ? created : null, createdAt: created, __v: 0,
      });
    }
    // A cancelled booking holds no nights (cancelCore → inventory.releaseNights).
    if (state !== "cancelled") addNights(propertyId, _id, days, "booking", holdExpiresAt, created);
    return _id;
  }

  /** A host calendar block: the host site sends 18:30Z instants; nights are the UTC days. */
  function hostBlock(code: string, from: string, to: string, released = false): ObjectId {
    const _id = oid("c1", ++seq);
    const propertyId = L(code);
    const days = span(from, to);
    const created = new Date(now.getTime() - 3 * 3_600_000);
    bookings.push({
      _id, userId: HOST_ID, source: "local", action: "host", sourceId: null, propertyId, hostId: HOST_ID,
      checkIn: new Date(`${from}T18:30:00.000Z`), checkOut: new Date(`${to}T18:30:00.000Z`), price: 0, subTotal: 0, currency: "INR",
      status: released ? "cancelled" : "confirmed", paymentStatus: "paid", flag: false, cancellationPolicy: "moderate",
      guests: 1, adults: 1, children: 0, infants: 0, nights: days.length, guestData: { adults: [], children: [] },
      reviewed: false, hostReviewed: false,
      quote: { basePrice: 0, nights: days.length, subTotalPaise: 0, serviceFeePaise: 0, gstPaise: 0, totalPaise: 0, currency: "INR" },
      holdExpiresAt: null, notifications: NOTIFICATIONS(), ...ATTENTION, createdAt: created, updatedAt: released ? now : created, __v: 0,
    });
    // unblockDates → inventory.releaseNights: a released block owns no night.
    if (!released) addNights(propertyId, _id, days, "block", null, created);
    return _id;
  }

  /** An imported OTA booking + its connection. `ownedDays` = the nights it owns in the ledger. */
  function imported(code: string, from: string, to: string, ownedDays: string[]): ObjectId {
    const _id = oid("c1", ++seq);
    const propertyId = L(code);
    const connectionId = oid("e1", seq);
    const url = `https://calendar-${code.toLowerCase()}.rig.invalid/feed.ics`; // .invalid never resolves (RFC 2606)
    const uid = `rig-event-${code.toLowerCase()}@calendar.rig.invalid`;
    const seen = new Date(now.getTime() - 2 * 3_600_000);
    calendars.push({
      _id: connectionId, propertyId, url, kind: "import", secret: sha256(`rig-feed-token:${code}`).slice(0, 43),
      channel: "GENERIC_ICAL", name: "Other calendar (iCal)", hostId: HOST_ID, status: "active", urlHash: sha256(url), exportScope: "destination",
      sync: {
        nextSyncAt: new Date(now.getTime() + DAY_MS), leaseUntil: null, leaseToken: null, firstAttemptAt: seen, lastAttemptAt: seen, lastSuccessAt: seen,
        lastChangeAt: seen, lastFullAt: seen, lastHttpStatus: 200, lastErrorCode: null, lastErrorAt: null, consecutiveFailures: 0,
        contentHash: sha256(`rig-feed:${code}`), eventCount: 1, pendingMissing: 0, pendingEchoes: 0, pendingFlags: 0,
        anomaly: null, anomalyAt: null, anomalyAlertedAt: null, alertedAt: null, lastDurationMs: 40, manualAt: null,
      },
      stats: {}, createdAt: seen, updatedAt: seen, __v: 0,
    });
    const days = span(from, to);
    bookings.push({
      _id, userId: HOST_ID, source: "ical", action: "user", sourceId: uid, propertyId, hostId: HOST_ID,
      checkIn: utc(from), checkOut: utc(to), price: 0, subTotal: 0, currency: "INR", status: "confirmed", paymentStatus: "paid",
      flag: false, cancellationPolicy: "moderate", guests: 0, adults: 1, nights: days.length, guestData: { adults: [], children: [] },
      reviewed: false, hostReviewed: false, quote: { currency: "INR" }, holdExpiresAt: null, notifications: NOTIFICATIONS(), ...ATTENTION,
      external: {
        connectionId, channel: "GENERIC_ICAL", key: uid, uid, state: "active", kind: "unknown",
        // icsReader.fingerprint: startDay|endDay|status|transparent|summaryKind
        fingerprint: sha256(`${from}|${to}|confirmed|0|unknown`).slice(0, 24),
        firstSeenAt: seen, lastChangedAt: seen, missingSyncs: 0,
        conflict: { withBookingIds: [], nights: [] }, // Mongoose's array defaults; no conflict recorded
        rev: 0,
      },
      createdAt: seen, updatedAt: seen, __v: 0,
    });
    addNights(propertyId, _id, ownedDays, "ical", null, seen);
    return _id;
  }

  // The fixed stay window most cases use.
  const [a, b, c, e] = [D(10), D(12), D(13), D(15)];
  const cases: AvailabilityCase[] = [];
  const add = (code: string, what: string, ranges: AvailabilityRange[]) => cases.push({ code, listingId: ids[code]!, what, ranges });
  const R = (label: string, from: string, to: string, free: boolean): AvailabilityRange => ({ label, from, to, free });

  add("A0", "control: no booking of any kind", [R("any range", a, c, true)]);

  guestBooking("A1", a, c, "paid");
  add("A1", `(a) paid, confirmed booking ${a} → ${c} with its three night rows`, [
    R("the booked stay itself", a, c, false),
    R("overlaps the first night", D(9), D(11), false),
    R("the last night only", b, c, false),
    R("spans across the booking", D(8), e, false),
    R("ends on the check-in day (day before)", D(8), a, true),
    R("starts on the checkout day (day after)", c, e, true),
  ]);

  guestBooking("A2", a, b, "paid");
  guestBooking("A2", b, e, "paid");
  add("A2", `(b) two back-to-back paid bookings ${a} → ${b} and ${b} → ${e} (checkout day = next check-in day)`, [
    R("the shared changeover day as a one-night stay", b, c, false),
    R("the last night of the first + the first night of the second", D(11), c, false),
    R("across both", a, e, false),
    R("ends on the first check-in day", D(8), a, true),
    R("starts on the second checkout day", e, D(17), true),
  ]);

  guestBooking("A3", a, b, "hold");
  add("A3", `(c) unpaid hold ${a} → ${b}, BookingNight.expiresAt 30 min after seeding`, [
    R("the held nights", a, b, false),
    R("starts on the hold's checkout day", b, D(14), true),
  ]);

  guestBooking("A4", a, b, "expired_hold");
  add("A4", `(d) unpaid hold ${a} → ${b} whose expiresAt passed 2 h before seeding (rows still present)`, [R("the once-held nights", a, b, true)]);

  guestBooking("A5", a, b, "cancelled");
  add("A5", `(e) booking ${a} → ${b} cancelled and refunded; its nights were released`, [R("the cancelled nights", a, b, true)]);

  hostBlock("A6", a, b);
  add("A6", `(f) host manual block, nights ${a} and ${D(11)} (stored as 18:30Z instants)`, [
    R("first blocked night", a, D(11), false),
    R("second blocked night", D(11), b, false),
    R("the night after the block", b, c, true),
    R("the night before the block", D(9), a, true),
  ]);

  imported("A7", a, c, span(a, c));
  add("A7", `(g) imported iCal booking ${a} → ${c}, owning all three nights (kind "ical")`, [
    R("a night inside the import", D(11), b, false),
    R("starts on the import's checkout day", c, D(14), true),
  ]);

  // Shared night: the host had blocked D(11) first, so the import owns only D(10) and D(12)
  // (ledger.claimNights: "host block / other import → shared (both block)").
  hostBlock("A8", D(11), b);
  imported("A8", a, c, [a, b]);
  add("A8", `(g) imported iCal booking ${a} → ${c} sharing night ${D(11)} with a live host block (the block owns that night row)`, [
    R("the shared night", D(11), b, false),
    R("a night the import owns", a, D(11), false),
  ]);

  // The same, after the host removed the block (unblockDates → releaseNights): the import's
  // Booking still covers D(11) but no BookingNight row exists for it until a full sync pass.
  hostBlock("A9", D(11), b, true);
  imported("A9", a, c, [a, b]);
  add("A9", `(g) imported iCal booking ${a} → ${c} whose shared night ${D(11)} lost its owner (the block was released; no night row left)`, [
    R("a night the import owns", a, D(11), false),
    R("the night only the import's Booking covers", D(11), b, false),
  ]);

  guestBooking("A10", a, b, "paid");
  add("A10", `(h) listing delisted by its host (status "inactive") after taking a paid booking ${a} → ${b}`, [
    R("dates it is booked for", a, b, false),
    R("dates nobody booked", D(20), D(22), false),
  ]);

  // Month end: the booking holds the last night of a month and the first of the next.
  const firstOfNext = (d: string, months: number) => new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1 + months, 1)).toISOString().slice(0, 10);
  let me = firstOfNext(today, 1);
  if (addDays(me, -3) < today) me = firstOfNext(today, 2);
  guestBooking("A11", addDays(me, -1), addDays(me, 1), "paid");
  add("A11", `month end: paid booking ${addDays(me, -1)} → ${addDays(me, 1)}`, [
    R("the last night of the month", addDays(me, -1), me, false),
    R("the first night of the next month", me, addDays(me, 1), false),
    R("a range across the month end", addDays(me, -3), addDays(me, 3), false),
    R("the two nights before, ending on the check-in day", addDays(me, -3), addDays(me, -1), true),
    R("starting on the checkout day", addDays(me, 1), addDays(me, 3), true),
  ]);

  // Year end: 30 Dec → 2 Jan.
  let ye = `${Number(today.slice(0, 4)) + 1}-01-01`;
  if (addDays(ye, -4) < today) ye = `${Number(today.slice(0, 4)) + 2}-01-01`;
  guestBooking("A12", addDays(ye, -2), addDays(ye, 1), "paid");
  add("A12", `year end: paid booking ${addDays(ye, -2)} → ${addDays(ye, 1)}`, [
    R("31 Dec → 1 Jan", addDays(ye, -1), ye, false),
    R("1 Jan → 2 Jan", ye, addDays(ye, 1), false),
    R("a range across the year end", addDays(ye, -3), addDays(ye, 2), false),
    R("ending on the check-in day (30 Dec)", addDays(ye, -4), addDays(ye, -2), true),
    R("starting on the checkout day (2 Jan)", addDays(ye, 1), addDays(ye, 3), true),
  ]);

  return {
    today, now, users, listings, bookings, nights, payments, calendars,
    // services/calendarSync/flags.js: with this flag on, a calendar view never fetches a feed.
    opsflags: [{ _id: "calendar_sync_paused", enabled: true, reason: "rag integration rig: no outbound fetches", updatedAt: now }],
    ids, cases,
  };
}
