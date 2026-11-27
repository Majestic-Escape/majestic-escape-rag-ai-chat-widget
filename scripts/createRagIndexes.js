// Creates the two expiry indexes of the search assistant. Idempotent.
//
//   node scripts/createRagIndexes.js            (reads MONGODB_URI from .env.local or the environment)
//
//   ai_chat_state.updatedAt  → documents removed 24 h after the last turn
//                              (the code already treats 30 idle minutes as a fresh search;
//                               this only keeps the collection from growing)
//   ai_usage.createdAt       → daily counters removed after 90 days
//
// Nothing else reads or writes these collections. To undo: drop the collections.

const fs = require("fs");
const { MongoClient } = require("mongodb");

if (!process.env.MONGODB_URI && fs.existsSync(".env.local")) {
  for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*MONGODB_URI\s*=\s*(.*)$/);
    if (m) process.env.MONGODB_URI = m[1].trim().replace(/^["']|["']$/g, "");
  }
}
const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI is not set");
  process.exit(1);
}

(async () => {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  try {
    await client.connect();
    const db = client.db(uri.split("/").pop().split("?")[0] || "master-db");
    console.log("database:", db.databaseName);
    console.log(await db.collection("ai_chat_state").createIndex({ updatedAt: 1 }, { name: "expire_idle_state", expireAfterSeconds: 24 * 60 * 60 }));
    console.log(await db.collection("ai_usage").createIndex({ createdAt: 1 }, { name: "expire_old_usage", expireAfterSeconds: 90 * 24 * 60 * 60 }));
  } finally {
    await client.close();
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
