// Integration-test harness: loads the REAL server code (TypeScript, transpiled
// on the fly) against a throwaway local MongoDB replica set. Only the Next.js
// runtime pieces and `@/auth` are stubbed.
//
// SAFETY: this file refuses to run against anything but the throwaway local
// replica set on port 27018 (database `tenant_itest`). It never reads
// .env.local.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";

export const ITEST_URI =
  process.env.ITEST_MONGODB_URI ??
  "mongodb://localhost:27018/tenant_itest?replicaSet=rs0&directConnection=true";

export function assertSafeUri(uri) {
  if (!uri.startsWith("mongodb://localhost:27018/")) {
    throw new Error(`REFUSING to run integration tests against ${uri.split("@").pop()}`);
  }
  const db = uri.slice("mongodb://localhost:27018/".length).split("?")[0];
  if (db !== "tenant_itest") {
    throw new Error(`REFUSING: integration database must be tenant_itest, got ${db}`);
  }
}
assertSafeUri(ITEST_URI);

// The app's db.ts reads MONGODB_URI at module load. Always overwrite it.
process.env.MONGODB_URI = ITEST_URI;
process.env.AUTH_SECRET = "itest-only-signing-secret-not-for-production";
process.env.PUBLIC_ACCESS_PIN = "0427";

const nodeRequire = createRequire(import.meta.url);
export const root = path.resolve(import.meta.dirname, "..", "..", "..");
const srcRoot = path.join(root, "src");

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

export const state = {
  session: null,
  revalidated: [],
  cookiesSet: [],
};

export class RedirectError extends Error {
  constructor(url) {
    super(`NEXT_REDIRECT:${url}`);
    this.url = url;
    this.digest = `NEXT_REDIRECT;replace;${url};307;`;
  }
}
export class NotFoundError extends Error {
  constructor() {
    super("NEXT_NOT_FOUND");
    this.digest = "NEXT_HTTP_ERROR_FALLBACK;404";
  }
}

const stubs = {
  "server-only": {},
  "next/cache": {
    revalidatePath: (p) => state.revalidated.push(p),
    revalidateTag: () => {},
  },
  "next/navigation": {
    redirect: (url) => {
      throw new RedirectError(url);
    },
    permanentRedirect: (url) => {
      throw new RedirectError(url);
    },
    notFound: () => {
      throw new NotFoundError();
    },
  },
  "next/headers": {
    headers: async () => new Headers({ "user-agent": "itest" }),
    cookies: async () => ({
      get: () => undefined,
      set: (...args) => state.cookiesSet.push(args),
      delete: () => {},
    }),
  },
  "@/auth": {
    auth: async () => state.session,
    signIn: async () => {
      throw new Error("signIn is not available in integration tests");
    },
    signOut: async () => {},
    handlers: {},
  },
};

/** Set the signed-in user for subsequent action calls (null = signed out). */
export function signInAs(user) {
  state.session = user
    ? {
        user: {
          id: String(user._id),
          name: user.name,
          email: user.email ?? null,
          role: user.role,
        },
      }
    : null;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

const cache = new Map();

function resolveFile(base) {
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
  ]) {
    if (existsSync(candidate) && !candidate.endsWith(path.sep) && path.extname(candidate)) {
      return candidate;
    }
  }
  return null;
}

function requireFrom(fromFile, name) {
  if (Object.hasOwn(stubs, name)) return stubs[name];
  let target = null;
  if (name.startsWith("@/")) target = resolveFile(path.join(srcRoot, name.slice(2)));
  else if (name.startsWith("./") || name.startsWith("../")) {
    target = resolveFile(path.resolve(path.dirname(fromFile), name));
  }
  if (target && /\.tsx?$/.test(target)) return loadFile(target);
  if (target) return nodeRequire(target);
  if (name.startsWith("@/")) throw new Error(`Cannot resolve ${name} from ${fromFile}`);
  return nodeRequire(name);
}

function loadFile(filename) {
  if (cache.has(filename)) return cache.get(filename).exports;
  const source = readFileSync(filename, "utf8");
  const compiled = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });
  const mod = new Module(filename);
  mod.filename = filename;
  cache.set(filename, mod);
  mod.require = (name) => requireFrom(filename, name);
  mod._compile(compiled.outputText, filename);
  return mod.exports;
}

/** Load a module from the repo, e.g. load("src/lib/ledger.ts"). */
export function load(relativePath) {
  return loadFile(path.join(root, ...relativePath.split(/[\\/]/)));
}

// ---------------------------------------------------------------------------
// Database lifecycle
// ---------------------------------------------------------------------------

export const mongoose = nodeRequire("mongoose");

export const models = {
  Building: () => load("src/models/Building.ts").Building,
  Unit: () => load("src/models/Unit.ts").Unit,
  User: () => load("src/models/User.ts").User,
  Tenancy: () => load("src/models/Tenancy.ts").Tenancy,
  MonthlyPeriod: () => load("src/models/MonthlyPeriod.ts").MonthlyPeriod,
  Charge: () => load("src/models/Charge.ts").Charge,
  Payment: () => load("src/models/Payment.ts").Payment,
  Income: () => load("src/models/Income.ts").Income,
  Expense: () => load("src/models/Expense.ts").Expense,
  Withdrawal: () => load("src/models/Withdrawal.ts").Withdrawal,
  MonthMedia: () => load("src/models/MonthMedia.ts").MonthMedia,
  AuditLog: () => load("src/models/AuditLog.ts").AuditLog,
};

export function M() {
  return Object.fromEntries(Object.entries(models).map(([k, f]) => [k, f()]));
}

/** Connect through the app's own connectDB, drop tenant_itest, rebuild indexes. */
export async function freshDatabase() {
  assertSafeUri(ITEST_URI);
  const { connectDB } = load("src/lib/db.ts");
  const conn = await connectDB();
  const db = conn.connection.db;
  assert.equal(db.databaseName, "tenant_itest", "connected to the wrong database");
  await db.dropDatabase();
  const all = M();
  for (const model of Object.values(all)) {
    await model.createCollection().catch(() => {});
    await model.createIndexes();
  }
  return { conn, db, ...all };
}

export async function disconnect() {
  await mongoose.disconnect();
  global._mongooseCache = undefined;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export function fd(fields) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null) form.set(k, String(v));
  }
  return form;
}

export const PREV = { error: null };

let nidSeq = 0;
export function nextNid() {
  nidSeq += 1;
  return `NID${process.pid}${nidSeq}`;
}

export async function makeBuildingFixture({ name = "Itest Tower", units = ["1A", "1B", "2A", "2B"] } = {}) {
  const { Building, Unit, User } = M();
  const building = await Building.create({ name, numberOfFloors: 3 });
  const unitDocs = [];
  for (const label of units) {
    unitDocs.push(
      await Unit.create({
        buildingId: building._id,
        floorNumber: Number(label[0]) || 1,
        label,
        serviceChargeAmount: 0,
      }),
    );
  }
  return { building, units: unitDocs, User };
}

export async function makeStaff(managedBuildingIds = []) {
  const { User } = M();
  const stamp = `${Date.now()}${Math.random().toString(16).slice(2, 8)}`;
  const superAdmin = await User.create({
    name: "Super Admin",
    email: `sa-${stamp}@itest.local`,
    role: "SUPER_ADMIN",
  });
  const manager = await User.create({
    name: "Manager",
    email: `mgr-${stamp}@itest.local`,
    role: "MANAGER",
    managedBuildingIds,
  });
  return { superAdmin, manager };
}

export async function makeTenant(buildingId, unitId, name = "Tenant") {
  const { User, Tenancy } = M();
  const user = await User.create({ name, nid: nextNid(), role: "TENANT" });
  const tenancy = await Tenancy.create({
    buildingId,
    unitId,
    userId: user._id,
    isActive: true,
  });
  return { user, tenancy };
}
