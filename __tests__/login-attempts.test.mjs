import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { fakeCollection, fakeDb } from "./helpers/fake-mongo.mjs";

const nodeRequire = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");

function load(relativePath, dependencies = {}) {
  const filename = path.join(root, ...relativePath.split(/[\\/]/));
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const loaded = new Module(filename);
  loaded.require = (name) =>
    Object.hasOwn(dependencies, name) ? dependencies[name] : nodeRequire(name);
  loaded._compile(compiled.outputText, filename);
  return loaded.exports;
}

const now = 1_800_000_000_000;
const WINDOW = 15 * 60_000;
process.env.AUTH_SECRET = "test-only-signing-secret-not-for-production";

function limiterFixture(initial) {
  const collection = fakeCollection(initial);
  const limiter = load("src\\lib\\login-attempts.ts", {
    "@/lib/db": fakeDb({ login_attempts: collection }),
  });
  return { limiter, collection };
}

test("email is stored only as a keyed hash of its normalised form", () => {
  const { limiter } = limiterFixture();
  const id = limiter.loginAttemptId(" Admin@Example.com ");
  assert.equal(id, limiter.loginAttemptId("admin@example.com"));
  assert.match(id, /^email:[a-f0-9]{64}$/);
  assert.doesNotMatch(id, /admin|example/i);
  assert.notEqual(id, limiter.loginAttemptId("other@example.com"));
});

test("five failures per email per 15 minutes, then a lockout with the remaining wait", async () => {
  const { limiter, collection } = limiterFixture();
  for (let i = 0; i < 5; i++) {
    const result = await limiter.reserveLoginAttempt("a@example.com", now + i);
    assert.equal(result.allowed, true);
    await limiter.settleLoginAttempt(result.reservation, "failure");
  }
  const blocked = await limiter.reserveLoginAttempt("a@example.com", now + 5 * 60_000);
  assert.deepEqual(blocked, { allowed: false, retryAfterMs: 10 * 60_000 });
  assert.equal(limiter.loginLockoutMessage(blocked.retryAfterMs), "Too many attempts, try again in 10 minutes.");
  assert.equal(limiter.loginLockoutMessage(30_000), "Too many attempts, try again in 1 minute.");

  const doc = collection.docs.get(limiter.loginAttemptId("a@example.com"));
  assert.equal(doc.failures, 5, "refused attempts are not counted");
  assert.deepEqual(doc.expiresAt, new Date(now + WINDOW));
  assert.equal(collection.docs.get("global").failures, 5, "a refused attempt does not consume the global budget");

  // Other accounts are unaffected; the locked one reopens when its window ends.
  assert.equal((await limiter.reserveLoginAttempt("b@example.com", now + 5 * 60_000)).allowed, true);
  assert.equal((await limiter.reserveLoginAttempt("a@example.com", now + WINDOW)).allowed, true);
  assert.equal(collection.docs.get(limiter.loginAttemptId("a@example.com")).failures, 1);
});

test("successful login resets the email's counter and returns its global slot", async () => {
  const { limiter, collection } = limiterFixture();
  for (let i = 0; i < 4; i++) {
    const { reservation } = await limiter.reserveLoginAttempt("a@example.com", now);
    await limiter.settleLoginAttempt(reservation, "failure");
  }
  const { reservation } = await limiter.reserveLoginAttempt("a@example.com", now);
  await limiter.settleLoginAttempt(reservation, "success");
  assert.equal(collection.docs.has(limiter.loginAttemptId("a@example.com")), false);
  assert.equal(collection.docs.get("global").failures, 4);
  for (let i = 0; i < 5; i++) {
    assert.equal((await limiter.reserveLoginAttempt("a@example.com", now)).allowed, true);
  }
});

test("unexpected errors return both reserved slots", async () => {
  const { limiter, collection } = limiterFixture();
  const { reservation } = await limiter.reserveLoginAttempt("a@example.com", now);
  await limiter.settleLoginAttempt(reservation, "error");
  assert.equal(collection.docs.get(limiter.loginAttemptId("a@example.com")).failures, 0);
  assert.equal(collection.docs.get("global").failures, 0);
});

test("global cap of 100 failures per 15 minutes stops credential spraying", async () => {
  const { limiter, collection } = limiterFixture();
  for (let i = 0; i < 100; i++) {
    const result = await limiter.reserveLoginAttempt(`user${i}@example.com`, now);
    assert.equal(result.allowed, true);
    await limiter.settleLoginAttempt(result.reservation, "failure");
  }
  const blocked = await limiter.reserveLoginAttempt("victim@example.com", now + 60_000);
  assert.deepEqual(blocked, { allowed: false, retryAfterMs: 14 * 60_000 });
  assert.equal(collection.docs.get("global").failures, 100);
  assert.equal(
    collection.docs.get(limiter.loginAttemptId("victim@example.com")).failures,
    0,
    "the refused email's reservation is given back",
  );
  assert.equal((await limiter.reserveLoginAttempt("victim@example.com", now + WINDOW)).allowed, true);
});

test("TTL index is created on the new collection only, once", async () => {
  const { limiter, collection } = limiterFixture();
  await limiter.reserveLoginAttempt("a@example.com", now);
  await limiter.reserveLoginAttempt("a@example.com", now);
  const indexes = collection.calls.filter(([name]) => name === "createIndex");
  assert.deepEqual(indexes, [["createIndex", { expiresAt: 1 }, { expireAfterSeconds: 0 }]]);
});

function actionFixture({ allowed = true, retryAfterMs = 0, signInResult } = {}) {
  const settled = [];
  const reserved = [];
  const signIns = [];
  class AuthError extends Error {}
  const realLimiter = load("src\\lib\\login-attempts.ts", { "@/lib/db": fakeDb({}) });
  const actions = load("src\\app\\(auth)\\login\\actions.ts", {
    "next-auth": { AuthError },
    "next/navigation": { redirect: (url) => { throw new Error(`REDIRECT:${url}`); } },
    "@/auth": {
      signIn: async (...args) => {
        signIns.push(args);
        if (signInResult === "auth-error") throw new AuthError("CredentialsSignin");
        if (signInResult === "crash") throw new Error("database down");
        return "http://localhost:3000/dashboard";
      },
    },
    "@/lib/validators/auth": load("src\\lib\\validators\\auth.ts"),
    "@/lib/login-attempts": {
      loginLockoutMessage: realLimiter.loginLockoutMessage,
      reserveLoginAttempt: async (email) => {
        reserved.push(email);
        return allowed
          ? { allowed: true, reservation: { emailId: "id" } }
          : { allowed: false, retryAfterMs };
      },
      settleLoginAttempt: async (_reservation, outcome) => { settled.push(outcome); },
    },
  });
  const form = new FormData();
  form.set("email", " Admin@Example.com ");
  form.set("password", "secret");
  return { actions, form, settled, reserved, signIns };
}

test("login success resets the counter and redirects to the dashboard", async () => {
  const fixture = actionFixture();
  await assert.rejects(fixture.actions.login({ error: null }, fixture.form), /REDIRECT:http:\/\/localhost:3000\/dashboard/);
  assert.deepEqual(fixture.reserved, ["admin@example.com"]);
  assert.deepEqual(fixture.settled, ["success"]);
  assert.deepEqual(fixture.signIns[0], [
    "credentials",
    { email: "admin@example.com", password: "secret", redirectTo: "/dashboard", redirect: false },
  ]);
});

test("wrong credentials keep the generic message and count as a failure", async () => {
  const fixture = actionFixture({ signInResult: "auth-error" });
  assert.deepEqual(await fixture.actions.login({ error: null }, fixture.form), {
    error: "Invalid email or password.",
    email: "admin@example.com",
  });
  assert.deepEqual(fixture.settled, ["failure"]);
});

test("limited logins never reach the password check", async () => {
  const fixture = actionFixture({ allowed: false, retryAfterMs: 7 * 60_000 + 1 });
  assert.deepEqual(await fixture.actions.login({ error: null }, fixture.form), {
    error: "Too many attempts, try again in 8 minutes.",
    email: "admin@example.com",
  });
  assert.equal(fixture.signIns.length, 0);
  assert.deepEqual(fixture.settled, []);
});

test("unexpected sign-in errors are rethrown and not counted against the user", async () => {
  const fixture = actionFixture({ signInResult: "crash" });
  await assert.rejects(fixture.actions.login({ error: null }, fixture.form), /database down/);
  assert.deepEqual(fixture.settled, ["error"]);
});

test("invalid input is rejected before touching the limiter", async () => {
  const fixture = actionFixture();
  const form = new FormData();
  form.set("email", "not-an-email");
  form.set("password", "x");
  assert.deepEqual(await fixture.actions.login({ error: null }, form), {
    error: "Enter a valid email and password.",
    email: "not-an-email",
  });
  assert.equal(fixture.reserved.length, 0);
});
