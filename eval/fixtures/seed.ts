// Seeds the integration-rig fixtures into a LOCAL database with the MongoDB driver.
//
//   RAG_RIG_DB_URI="mongodb://127.0.0.1:27417/rag_rig_<suffix>?replicaSet=rs0" npx tsx eval/fixtures/seed.ts [--today=YYYY-MM-DD]
//
// Refuses anything that is not 127.0.0.1/localhost and a database named rag_rig_*.
// Re-runnable: it empties the fixture collections of that one database first
// (indexes are kept). Run it again whenever the hold in case A3 has expired
// (30 minutes) or the calendar day has changed.

import { writeFileSync, mkdirSync } from "node:fs";
import { BSON, MongoClient } from "mongodb";
import { istToday } from "../../src/lib/rag/dates";
import { buildFixtures } from "./generate";

const uri = process.env.RAG_RIG_DB_URI ?? "";
const m = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/(rag_rig_[a-z0-9]+)(\?.*)?$/.exec(uri);
if (!m) {
  console.error("refusing: RAG_RIG_DB_URI must be mongodb://127.0.0.1|localhost[:port]/rag_rig_<suffix>[?…]");
  process.exit(1);
}
const dbName = m[3]!;
const todayArg = process.argv.find((a) => a.startsWith("--today="))?.slice(8);
const now = new Date();
const today = todayArg ?? istToday(now);
if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
  console.error("--today must be YYYY-MM-DD");
  process.exit(1);
}

async function main(): Promise<void> {
  const fx = buildFixtures(today, now);
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  try {
    const db = client.db(dbName);
    const sets: [string, Record<string, unknown>[]][] = [
      ["users", fx.users],
      ["listingproperties", fx.listings],
      ["bookings", fx.bookings],
      ["bookingnights", fx.nights],
      ["payments", fx.payments],
      ["externalcalendars", fx.calendars],
      ["opsflags", fx.opsflags],
    ];
    for (const [name, docs] of sets) {
      await db.collection(name).deleteMany({});
      if (docs.length) await db.collection(name).insertMany(docs);
      console.log(`${name}: ${docs.length}`);
    }
    mkdirSync("eval/fixtures/data", { recursive: true });
    // The documents exactly as inserted (Extended JSON keeps ObjectIds and dates).
    writeFileSync("eval/fixtures/data/fixtures.json", BSON.EJSON.stringify(fx, undefined, 1, { relaxed: false }) + "\n");
    // What the verifier needs to find them again. A local URI only — no secret.
    const hold = fx.bookings.find((b) => b.status === "pending" && b.holdExpiresAt instanceof Date && (b.holdExpiresAt as Date) > now);
    writeFileSync(
      "eval/fixtures/data/seeded.json",
      JSON.stringify({ dbUri: uri, dbName, today, seededAt: now.toISOString(), liveHoldExpiresAt: (hold?.holdExpiresAt as Date | undefined)?.toISOString() ?? null }, null, 1) + "\n"
    );
    console.log(`seeded ${dbName} for today=${today}; the live hold (case A3) expires at ${(hold?.holdExpiresAt as Date).toISOString()}`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
