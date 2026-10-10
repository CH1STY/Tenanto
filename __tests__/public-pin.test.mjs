import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

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

const pin = load("src\\lib\\public-pin.ts");
const now = 1_800_000_000_000;

function configure() {
  process.env.PUBLIC_ACCESS_PIN = "0427";
  process.env.AUTH_SECRET = "test-only-signing-secret-not-for-production";
}

test("PIN matching preserves leading zeros and rejects invalid input", () => {
  configure();
  assert.equal(pin.matchesPublicPin("0427"), true);
  for (const value of ["427", "0000", "04270", " 0427", 427, null]) {
    assert.equal(pin.matchesPublicPin(value), false);
  }
});

test("signed access expires at exactly six hours, not a sliding deadline", () => {
  configure();
  const token = pin.createPublicPinToken(now);
  assert.equal(pin.PUBLIC_PIN_MAX_AGE, 21600);
  assert.equal(pin.hasValidPublicPin(token, now), true);
  assert.equal(pin.hasValidPublicPin(token, now + 21_599_000), true);
  assert.equal(pin.hasValidPublicPin(token, now + 21_600_000), false);
  assert.equal(pin.hasValidPublicPin(token, now - 1000), false);
  assert.equal(pin.hasValidPublicPin(undefined, now), false);
});

test("tampering and rotating either secret revoke PIN access", () => {
  configure();
  const token = pin.createPublicPinToken(now);
  const altered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
  assert.equal(pin.hasValidPublicPin(altered, now), false);
  process.env.PUBLIC_ACCESS_PIN = "7777";
  assert.equal(pin.hasValidPublicPin(token, now), false);
  configure();
  process.env.AUTH_SECRET = "another-test-secret";
  assert.equal(pin.hasValidPublicPin(token, now), false);
});

test("signed-in visitors bypass PIN, missing configuration fails closed", () => {
  configure();
  delete process.env.PUBLIC_ACCESS_PIN;
  assert.equal(pin.publicAccessAllowed(true, undefined, now), true);
  assert.throws(() => pin.publicAccessAllowed(false, undefined, now), /PUBLIC_ACCESS_PIN/);
  configure();
  assert.equal(pin.publicAccessAllowed(false, undefined, now), false);
});

test("return URLs remain local and cannot redirect back to the gate", () => {
  for (const value of ["https://example.com", "//example.com", "/\\example.com", "/pin", "/pin/child", "/login", null]) {
    assert.equal(pin.safePinReturnTo(value), "/");
  }
  assert.equal(pin.safePinReturnTo("/buildings/abc?month=2026-10"), "/buildings/abc?month=2026-10");
});

function actionFixture({ signedIn = false, allowed = true } = {}) {
  const writes = [];
  let attempts = 0;
  const actions = load("src\\app\\(auth)\\pin\\actions.ts", {
    "next/headers": { cookies: async () => ({ set: (...args) => writes.push(args) }) },
    "next/navigation": { redirect: (url) => { throw new Error(`REDIRECT:${url}`); } },
    "@/auth": { auth: async () => signedIn ? { user: { id: "test-user" } } : null },
    "@/lib/public-pin": pin,
    "@/lib/public-pin-attempts": {
      consumePublicPinAttempt: async () => { attempts++; return allowed; },
    },
  });
  return { actions, writes, attempts: () => attempts };
}

test("correct entry sets a six-hour HttpOnly cookie and redirects to the original page", async () => {
  configure();
  const fixture = actionFixture();
  const form = new FormData();
  form.set("pin", "0427");
  form.set("returnTo", "/buildings?month=2026-10");
  await assert.rejects(fixture.actions.unlockPublicPages({}, form), /REDIRECT:\/buildings\?month=2026-10/);
  assert.equal(fixture.attempts(), 1);
  const [name, token, options] = fixture.writes[0];
  assert.equal(name, pin.PUBLIC_PIN_COOKIE);
  assert.equal(pin.hasValidPublicPin(token), true);
  assert.deepEqual(options, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 21600,
  });
});

test("incorrect or rate-limited submissions never create access cookies", async () => {
  configure();
  for (const [value, allowed, message] of [["0000", true, /Incorrect PIN/], ["0427", false, /Too many PIN/]]) {
    const fixture = actionFixture({ allowed });
    const form = new FormData();
    form.set("pin", value);
    const result = await fixture.actions.unlockPublicPages({}, form);
    assert.match(result.error, message);
    assert.equal(fixture.writes.length, 0);
  }
});

test("signed-in submission bypasses PIN and rate limiter", async () => {
  configure();
  const fixture = actionFixture({ signedIn: true });
  await assert.rejects(fixture.actions.unlockPublicPages({}, new FormData()), /REDIRECT:\//);
  assert.equal(fixture.attempts(), 0);
  assert.equal(fixture.writes.length, 0);
});

test("proxy gates public pages and direct attachments, not login or signed-in visitors", async () => {
  configure();
  const proxy = load("src\\proxy.ts", {
    "next-auth": { default: () => ({ auth: (handler) => handler }) },
    "@/auth.config": { authConfig: {} },
    "@/lib/public-pin": pin,
  }).default;
  const request = (pathname, token, signedIn = false) => ({
    nextUrl: new URL(pathname, "https://example.com"),
    cookies: {
      get: () => token ? { value: token } : undefined,
      has: () => !!token,
    },
    auth: signedIn ? { user: { id: "test-user", role: "SUPER_ADMIN" } } : null,
  });
  for (const pathname of ["/", "/buildings", "/buildings/abc/media/def", "/buildings/abc.json"]) {
    const response = await proxy(request(pathname));
    assert.equal(response.status, 307);
    const location = new URL(response.headers.get("location"));
    assert.equal(location.pathname, "/pin");
    assert.equal(location.searchParams.get("returnTo"), pathname);
  }
  assert.equal(await proxy(request("/login")), undefined);
  assert.equal(await proxy(request("/pin")), undefined);
  assert.equal(await proxy(request("/buildings", pin.createPublicPinToken())), undefined);
  assert.equal(await proxy(request("/buildings", undefined, true)), undefined);
  const unlocked = await proxy(request("/pin?returnTo=%2Fbuildings", pin.createPublicPinToken()));
  assert.equal(new URL(unlocked.headers.get("location")).pathname, "/buildings");
});

test("server-side access guard protects calls independently of proxy routing", async () => {
  configure();
  for (const [signedIn, token, allowed] of [
    [false, undefined, false],
    [false, pin.createPublicPinToken(), true],
    [false, pin.createPublicPinToken(Date.now() - 21_600_000), false],
    [true, undefined, true],
  ]) {
    const access = load("src\\lib\\public-access.ts", {
      "next/headers": { cookies: async () => ({ get: () => ({ value: token }) }) },
      "next/navigation": { redirect: () => { throw new Error("PIN_REQUIRED"); } },
      "@/auth": { auth: async () => signedIn ? { user: { id: "test-user" } } : null },
      "@/lib/public-pin": pin,
    });
    if (allowed) await access.requirePublicAccess();
    else await assert.rejects(access.requirePublicAccess(), /PIN_REQUIRED/);
  }
});

test("production PIN cookie is HTTPS-only", async () => {
  configure();
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const fixture = actionFixture();
    const form = new FormData();
    form.set("pin", "0427");
    await assert.rejects(fixture.actions.unlockPublicPages({}, form), /REDIRECT:/);
    assert.equal(fixture.writes[0][2].secure, true);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test("database-backed limiter atomically resets the window and caps all instances at 20 submissions", async () => {
  let record;
  const limiter = load("src\\lib\\public-pin-attempts.ts", {
    "@/lib/db": {
      connectDB: async () => ({
        connection: { db: { collection: () => ({
          findOneAndUpdate: async (filter, pipeline, options) => {
            assert.deepEqual(filter, { _id: "shared" });
            assert.deepEqual(options, { upsert: true, returnDocument: "after" });
            const set = pipeline[0].$set;
            const threshold = set.windowStart.$cond[0].$lte[1];
            const expired = (record?.windowStart ?? 0) <= threshold;
            record = {
              windowStart: expired ? set.windowStart.$cond[1] : record.windowStart,
              attempts: expired ? 1 : record.attempts + set.attempts.$cond[2].$add[1],
            };
            return record;
          },
        }) } },
      }),
    },
  });
  for (let i = 1; i <= 21; i++) {
    assert.equal(await limiter.consumePublicPinAttempt(), i <= 20);
  }
  record.windowStart = Date.now() - 60_001;
  assert.equal(await limiter.consumePublicPinAttempt(), true);
  assert.equal(record.attempts, 1);
});
