// Saves real responses of server.me's public search into eval/contract/ so the
// pure checks (verify:rag) run against what the API actually returns.
// Read-only GETs; rows are trimmed to the fields the chat service reads.
//
// Run:  node scripts/capture-search-contract.mjs [baseUrl]
// Re-run when the backend's search changes, review the diff, bump `version`.

import { mkdirSync, writeFileSync } from "node:fs";

const base = (process.argv[2] ?? "https://server.majesticescape.in/api/v1").replace(/\/+$/, "");
const KEEP = [
  "_id", "title", "propertyType", "placeType", "guests", "bedrooms", "beds", "bathrooms",
  "amenities", "basePrice", "bookingType", "cancellationType", "selectedRules", "occupancy",
  "checkinTime", "checkoutTime", "status", "averageRating", "reviewCount", "distanceKm",
];
const far = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const CASES = {
  "all-limit50": "limit=50",
  "all-default-limit": "",
  "all-page2-limit16": "limit=16&page=2",
  "place-goa": "location=goa&limit=50",
  "place-anjuna": "location=anjuna&limit=50",
  "nearby-panaji": "location=panaji&limit=50",
  "nearby-empty-pune": "location=pune&limit=50",
  "corrected-mumbay": "location=mumbay&limit=50",
  "vague-hills": "location=hills&limit=50",
  "name-casa-feliz": "location=casa%20feliz&limit=50",
  "dated-goa": `location=goa&from=${far(40)}&to=${far(43)}&limit=50`,
  "bad-number": "location=goa&maxPrice=5,000&limit=50",
};

mkdirSync("eval/contract", { recursive: true });
for (const [name, query] of Object.entries(CASES)) {
  const res = await fetch(`${base}/properties/search-properties?${query}`);
  const body = await res.json().catch(() => null);
  if (body && Array.isArray(body.data)) {
    body.data = body.data.map((r) => {
      const out = Object.fromEntries(KEEP.filter((k) => k in r).map((k) => [k, r[k]]));
      if (r.address) out.address = { district: r.address.district, city: r.address.city, state: r.address.state };
      return out;
    });
  }
  writeFileSync(`eval/contract/${name}.json`, JSON.stringify({ version: 1, query, status: res.status, body }, null, 1) + "\n");
  console.log(name.padEnd(22), res.status, body?.search?.mode ?? "-", Array.isArray(body?.data) ? body.data.length : "-", "/", body?.pagination?.totalCount ?? "-");
}
