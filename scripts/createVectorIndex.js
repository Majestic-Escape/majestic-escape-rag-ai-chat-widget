/**
 * Creates or updates the MongoDB Atlas Vector Search index used by the RAG
 * chatbot's /api/chat route.
 *
 *   Run once after spinning up a new Atlas cluster (or any time the embedding
 *   model changes):
 *
 *     node scripts/createVectorIndex.js
 *
 * Uses gemini-embedding-001's default 3072-dimensional vectors. Filters on
 * `status` so the chatbot only surfaces active properties.
 *
 * Reads MONGODB_URI from the same .env.local that the runtime uses.
 * Uses Next.js's bundled env loader so we don't add a `dotenv` dep.
 */
const { loadEnvConfig } = require("@next/env");
loadEnvConfig(process.cwd());
const { MongoClient } = require("mongodb");

const INDEX_NAME = "listing_vector_index";
const COLLECTION = "listingproperties";
const NUM_DIMENSIONS = 3072;

const INDEX_DEFINITION = {
  fields: [
    {
      type: "vector",
      path: "embedding",
      numDimensions: NUM_DIMENSIONS,
      similarity: "cosine",
    },
    {
      type: "filter",
      path: "status",
    },
  ],
};

function isNotFoundError(err) {
  return (
    err.code === 26 ||
    err.codeName === "IndexNotFound" ||
    /not found|does not exist/i.test(err.message || "")
  );
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.DB_URI;
  if (!uri) {
    console.error("MONGODB_URI (or DB_URI) is not set in .env.local");
    process.exit(1);
  }

  console.log("Connecting to MongoDB Atlas...");
  const client = new MongoClient(uri);
  await client.connect();

  // Resolve DB name from the connection string (path component).
  const dbName = uri.split("/").pop()?.split("?")[0] || "master-db";
  const db = client.db(dbName);
  console.log("Connected to database:", db.databaseName);

  // Try update-in-place first (idempotent on a fresh cluster too — falls
  // through to create when the index doesn't exist yet).
  try {
    await db.command({
      updateSearchIndex: COLLECTION,
      name: INDEX_NAME,
      definition: INDEX_DEFINITION,
    });
    console.log(`Index "${INDEX_NAME}" updated to ${NUM_DIMENSIONS} dims.`);
    console.log("Atlas may take 1–2 minutes to rebuild it.");
    await client.close();
    return;
  } catch (updateErr) {
    if (isNotFoundError(updateErr)) {
      console.log("Index not found — creating fresh...");
    } else {
      console.log("Update attempt result:", updateErr.message);
      console.log("Trying to create instead...");
    }
  }

  try {
    await db.command({
      createSearchIndexes: COLLECTION,
      indexes: [
        {
          name: INDEX_NAME,
          type: "vectorSearch",
          definition: INDEX_DEFINITION,
        },
      ],
    });
    console.log(
      `Index "${INDEX_NAME}" created (${NUM_DIMENSIONS} dims, similarity=cosine).`
    );
    console.log("Atlas may take 1–2 minutes to mark it Active.");
  } catch (createErr) {
    console.error("Create failed:", createErr.message);
    console.log("\nManual fallback — create this index in the Atlas console:");
    console.log("  Database:   <your db>");
    console.log(`  Collection: ${COLLECTION}`);
    console.log(`  Index name: ${INDEX_NAME}`);
    console.log("  Definition:");
    console.log(
      JSON.stringify(
        { type: "vectorSearch", definition: INDEX_DEFINITION },
        null,
        2
      )
    );
    await client.close();
    process.exit(1);
  }

  await client.close();
}

main().catch((err) => {
  console.error("Fatal error:", err.message || err);
  process.exit(1);
});
