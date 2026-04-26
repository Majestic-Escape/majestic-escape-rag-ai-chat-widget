import { ObjectId } from "mongodb";
import clientPromise from "@/lib/mongodb";
import { embedAndSaveProperty, EMBEDDER_VERSION } from "@/lib/embedder";

export interface SyncStats {
  processed: number;
  errors: number;
  durationMs: number;
}

/**
 * One-shot reconciliation: re-embed any active property whose `embedding` is missing,
 * whose document `updatedAt` is newer than `embeddingUpdatedAt`, or whose stored
 * `embeddingVersion` is older than the current EMBEDDER_VERSION (forces re-index when
 * the embedder text format changes).
 *
 * Idempotent — safe to run multiple times. Designed to run once at process start.
 */
export async function runCatchUpSync(): Promise<SyncStats> {
  const start = Date.now();
  const client = await clientPromise;
  const uri = process.env.MONGODB_URI || "";
  const dbName = uri.split("/").pop()?.split("?")[0] || "master-db";
  const db = client.db(dbName);
  const coll = db.collection("listingproperties");

  const cursor = coll
    .find(
      {
        status: "active",
        $or: [
          { embedding: { $exists: false } },
          {
            $expr: {
              $gt: [
                "$updatedAt",
                { $ifNull: ["$embeddingUpdatedAt", new Date(0)] },
              ],
            },
          },
          {
            $expr: {
              $lt: [
                { $ifNull: ["$embeddingVersion", 0] },
                EMBEDDER_VERSION,
              ],
            },
          },
        ],
      },
      { projection: { _id: 1 } }
    )
    .batchSize(50);

  let processed = 0;
  let errors = 0;
  for await (const doc of cursor) {
    try {
      await embedAndSaveProperty(doc._id as ObjectId);
      processed++;
      if (processed % 25 === 0) {
        console.log(`[catchUpSync] processed ${processed} so far...`);
      }
      // light pacing to avoid Gemini rate limits
      await new Promise((r) => setTimeout(r, 80));
    } catch (err) {
      errors++;
      console.error(`[catchUpSync] failed for ${doc._id}:`, (err as Error).message);
    }
  }

  const durationMs = Date.now() - start;
  console.log(
    `[catchUpSync] done — processed=${processed} errors=${errors} duration=${durationMs}ms`
  );
  return { processed, errors, durationMs };
}
