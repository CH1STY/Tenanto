import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  throw new Error("MONGODB_URI is not set. Add it to your .env.local file.");
}

// Cache the connection across hot reloads in dev and across lambda invocations.
type MongooseCache = {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
};

declare global {
  // eslint-disable-next-line no-var
  var _mongooseCache: MongooseCache | undefined;
}

const cache: MongooseCache = global._mongooseCache ?? {
  conn: null,
  promise: null,
};

if (!global._mongooseCache) {
  global._mongooseCache = cache;
}

export async function connectDB(): Promise<typeof mongoose> {
  if (cache.conn) return cache.conn;

  if (!cache.promise) {
    mongoose.set("strictQuery", true);
    cache.promise = mongoose
      .connect(MONGODB_URI as string, {
        bufferCommands: false,
      })
      .catch((error: unknown) => {
        cache.promise = null;

        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          (error as { code?: string }).code === "ECONNREFUSED" &&
          "syscall" in error &&
          (error as { syscall?: string }).syscall === "querySrv"
        ) {
          throw new Error(
            "MongoDB SRV DNS lookup failed. If you are running locally, set MONGODB_URI to mongodb://127.0.0.1:27017/tenant_app?directConnection=true&replicaSet=rs0 and run `npm run db:up`.",
          );
        }

        throw error;
      });
  }

  cache.conn = await cache.promise;
  return cache.conn;
}
