import {
  ObjectId,
  ChangeStream,
  ChangeStreamDocument,
  ResumeToken,
} from "mongodb";
import clientPromise from "@/lib/mongodb";
import { embedAndSaveProperty, changedFieldsTriggerReembed, unsetEmbedding } from "@/lib/embedder";

// Persist worker state on globalThis so it survives Next.js dev-mode HMR and is
// observable from API routes loaded in separate module contexts.
interface CSGlobal {
  cs?: ChangeStream | null;
  lastEventTs?: Date | null;
  isRunning?: boolean;
}
const g = globalThis as unknown as { __chatbotCS?: CSGlobal };
if (!g.__chatbotCS) g.__chatbotCS = { cs: null, lastEventTs: null, isRunning: false };
const state = g.__chatbotCS;

export function getChangeStreamStats() {
  return { lastEventTs: state.lastEventTs ?? null, isRunning: !!state.isRunning };
}

/**
 * Watches `listingproperties` for inserts, updates, replaces, and deletes.
 * Re-embeds when any tracked field changes.
 *
 * On error, stream is closed and the loop reconnects after a 5s backoff.
 * Resume token is persisted to MongoDB only AFTER a successful processing pass —
 * so a crash mid-process re-runs the failed event on next boot.
 */
export async function startChangeStreamWorker(): Promise<void> {
  if (state.isRunning) return;
  state.isRunning = true;

  while (state.isRunning) {
    try {
      await runOnePass();
    } catch (err) {
      console.error("[changeStream] worker fatal — restarting in 5s", err);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

export function stopChangeStreamWorker() {
  state.isRunning = false;
  if (state.cs) {
    state.cs.close().catch(() => undefined);
    state.cs = null;
  }
}

async function runOnePass(): Promise<void> {
  const client = await clientPromise;
  const uri = process.env.MONGODB_URI || "";
  const dbName = uri.split("/").pop()?.split("?")[0] || "master-db";
  const db = client.db(dbName);
  const coll = db.collection("listingproperties");
  const tokenStore = db.collection<{ _id: string; token: ResumeToken; ts: Date }>(
    "changestream_resume"
  );

  const last = await tokenStore.findOne({ _id: "listingproperties" });

  state.cs = coll.watch(
    [
      {
        $match: {
          operationType: { $in: ["insert", "update", "replace", "delete"] },
        },
      },
    ],
    {
      fullDocument: "updateLookup",
      ...(last?.token ? { resumeAfter: last.token } : {}),
    }
  );

  console.log(
    `[changeStream] watching listingproperties${last?.token ? " (resumed from token)" : ""}`
  );

  for await (const change of state.cs as AsyncIterable<ChangeStreamDocument>) {
    try {
      await handleChange(change);
      state.lastEventTs = new Date();
      // Persist token AFTER successful processing — at-least-once semantics on crash
      const token = (change as { _id: ResumeToken })._id;
      await tokenStore.updateOne(
        { _id: "listingproperties" },
        { $set: { token, ts: new Date() } },
        { upsert: true }
      );
    } catch (err) {
      console.error("[changeStream] error processing event", err);
      // do NOT advance resume token; stream continues but next restart retries
    }
  }
}

async function handleChange(change: ChangeStreamDocument): Promise<void> {
  if (!("documentKey" in change) || !change.documentKey) return;
  const id = (change.documentKey as { _id: ObjectId })._id;
  if (!id) return;

  if (change.operationType === "delete") {
    await unsetEmbedding(id);
    console.log(`[changeStream] deleted → unset embedding ${id}`);
    return;
  }

  if (change.operationType === "insert" || change.operationType === "replace") {
    await embedAndSaveProperty(id);
    console.log(`[changeStream] ${change.operationType} → re-embedded ${id}`);
    return;
  }

  if (change.operationType === "update") {
    const updated = (change.updateDescription?.updatedFields ?? {}) as Record<string, unknown>;
    const removed = (change.updateDescription?.removedFields ?? []) as string[];
    const changedKeys = [...Object.keys(updated), ...removed];
    if (changedFieldsTriggerReembed(changedKeys)) {
      await embedAndSaveProperty(id);
      console.log(`[changeStream] update → re-embedded ${id} (changed: ${changedKeys.join(",")})`);
    }
  }
}
