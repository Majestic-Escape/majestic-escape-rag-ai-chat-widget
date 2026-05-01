import { MongoClient } from "mongodb";

declare global {
  // eslint-disable-next-line no-var
  var _mongoClientPromise: Promise<MongoClient> | undefined;
}

let cached: Promise<MongoClient> | null = null;

function ensureConnection(): Promise<MongoClient> {
  if (cached) return cached;
  if (global._mongoClientPromise) {
    cached = global._mongoClientPromise;
    return cached;
  }
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    return Promise.reject(new Error("[mongodb] MONGODB_URI not set"));
  }
  const client = new MongoClient(uri);
  global._mongoClientPromise = client.connect();
  cached = global._mongoClientPromise;
  return cached;
}

// Lazy thenable: behaves like a Promise<MongoClient> for callers (`await
// clientPromise` works unchanged) but only triggers `new MongoClient` and
// `.connect()` on the first await. This matters because Next.js's build-time
// "Collecting page data" pass imports route modules to inspect their exports,
// and Railway's Nixpacks build does not expose user env vars during build —
// so MONGODB_URI is undefined at build time and an eager MongoClient
// construction would crash with "Cannot read properties of undefined
// (reading 'startsWith')". At runtime the env var is set, the first await
// connects, and every subsequent caller reuses the cached connection
// (matching the previous singleton behaviour, including HMR survival via
// `global._mongoClientPromise`).
const clientPromise = {
  then<T1 = MongoClient, T2 = never>(
    onResolve?: ((value: MongoClient) => T1 | PromiseLike<T1>) | null,
    onReject?: ((reason: unknown) => T2 | PromiseLike<T2>) | null
  ): Promise<T1 | T2> {
    return ensureConnection().then(onResolve as never, onReject as never);
  },
  catch<T = never>(
    onReject?: ((reason: unknown) => T | PromiseLike<T>) | null
  ): Promise<MongoClient | T> {
    return ensureConnection().catch(onReject as never);
  },
  finally(onFinally?: (() => void) | null): Promise<MongoClient> {
    return ensureConnection().finally(onFinally as never);
  },
  [Symbol.toStringTag]: "Promise",
} as unknown as Promise<MongoClient>;

export default clientPromise;
