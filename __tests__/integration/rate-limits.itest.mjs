// PIN + login rate limiters against a REAL MongoDB server (the unit tests use
// a fake collection that only simulates the update pipelines).
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import {
  RedirectError,
  disconnect,
  fd,
  freshDatabase,
  load,
  signInAs,
  state,
} from "./helpers/harness.mjs";

const PIN = load("src/lib/public-pin-attempts.ts");
const PinAction = load("src/app/(auth)/pin/actions.ts");
const LOGIN = load("src/lib/login-attempts.ts");

let ctx;
before(async () => {
  ctx = await freshDatabase();
});
after(async () => {
  await disconnect();
});

const pins = () => ctx.db.collection("public_pin_attempts");
const logins = () => ctx.db.collection("login_attempts");

describe("public PIN limiter (src/lib/public-pin-attempts.ts)", () => {
  beforeEach(async () => {
    await pins().deleteMany({});
  });

  test("10 failures per minute pass, the 11th locks; lock expires with the window", async () => {
    const now = 1_900_000_000_000;
    for (let i = 0; i < 10; i++) {
      assert.equal(await PIN.recordFailedPublicPinAttempt(now + i), 0, `failure ${i + 1}`);
    }
    const wait = await PIN.recordFailedPublicPinAttempt(now + 10);
    assert.ok(wait > 0 && wait <= 60_000, `wait ${wait}`);
    assert.equal(await PIN.publicPinRetryAfter(now + 10), 60_000 - 10);
    const doc = await pins().findOne({ _id: "shared" });
    assert.equal(doc.failMinuteCount, 10, "failures during lockout are not counted");
    assert.equal(doc.failHourCount, 10);
    // Next minute window: allowed again, hour counter keeps counting.
    assert.equal(await PIN.publicPinRetryAfter(now + 60_000), 0);
    assert.equal(await PIN.recordFailedPublicPinAttempt(now + 60_000), 0);
    const doc2 = await pins().findOne({ _id: "shared" });
    assert.equal(doc2.failMinuteCount, 1);
    assert.equal(doc2.failHourCount, 11);
  });

  test("hourly cap: 100 failures spread over minutes lock for the rest of the hour", async () => {
    const t0 = 1_900_100_000_000;
    let accepted = 0;
    for (let w = 0; w < 11; w++) {
      for (let i = 0; i < 10; i++) {
        if ((await PIN.recordFailedPublicPinAttempt(t0 + w * 60_000 + i)) === 0) accepted += 1;
      }
    }
    assert.equal(accepted, 100);
    const at = t0 + 10 * 60_000 + 20;
    assert.equal(await PIN.publicPinRetryAfter(at), t0 + 3_600_000 - at);
    assert.equal(await PIN.publicPinRetryAfter(t0 + 3_600_000), 0);
  });

  test("CONCURRENCY: 30 parallel failures on a fresh counter -> exactly 10 within budget", async () => {
    const now = 1_900_200_000_000;
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, () => PIN.recordFailedPublicPinAttempt(now)),
    );
    const thrown = results.filter((r) => r.status === "rejected");
    assert.equal(thrown.length, 0, String(thrown[0]?.reason));
    const passed = results.filter((r) => r.value === 0).length;
    assert.equal(passed, 10);
    const doc = await pins().findOne({ _id: "shared" });
    assert.equal(doc.failMinuteCount, 10);
    assert.equal(await pins().countDocuments({}), 1, "upsert race must not create extra docs");
  });

  test("action: wrong PIN x10 -> 'Incorrect PIN', then locked; a CORRECT PIN is refused while locked", async () => {
    signInAs(null);
    state.cookiesSet.length = 0;
    const submit = (pin) => PinAction.unlockPublicPages({ error: null }, fd({ pin, returnTo: "/buildings" }));
    for (let i = 0; i < 10; i++) {
      assert.deepEqual(await submit("1111"), { error: "Incorrect PIN. Enter the access PIN." });
    }
    assert.match((await submit("1111")).error, /Too many PIN attempts/);
    const correct = await submit("0427");
    assert.match(correct.error, /Too many PIN attempts/);
    assert.equal(state.cookiesSet.length, 0, "no access cookie may be issued while locked");

    // Unlocked: the correct PIN sets the cookie and redirects (no budget used).
    await pins().deleteMany({});
    await assert.rejects(submit("0427"), (err) => err instanceof RedirectError && err.url === "/buildings");
    assert.equal(state.cookiesSet.length, 1);
    assert.equal(state.cookiesSet[0][0], "tenant-public-access");
    assert.equal(await pins().countDocuments({}), 0, "a correct PIN must not consume budget");
  });

  test("action CONCURRENCY: 30 parallel wrong PINs -> at most 10 'Incorrect PIN' responses", async () => {
    signInAs(null);
    const results = await Promise.all(
      Array.from({ length: 30 }, () => PinAction.unlockPublicPages({ error: null }, fd({ pin: "9999" }))),
    );
    const incorrect = results.filter((r) => r.error?.startsWith("Incorrect PIN")).length;
    assert.equal(incorrect, 10);
    assert.equal(results.length - incorrect, 20);
  });
});

describe("login limiter (src/lib/login-attempts.ts)", () => {
  beforeEach(async () => {
    await logins().deleteMany({});
  });

  test("per-email lock after 5 failures; window expiry unlocks; email stored only hashed", async () => {
    const now = 1_900_300_000_000;
    for (let i = 0; i < 5; i++) {
      const r = await LOGIN.reserveLoginAttempt("victim@example.com", now + i);
      assert.equal(r.allowed, true, `attempt ${i + 1}`);
      await LOGIN.settleLoginAttempt(r.reservation, "failure");
    }
    const locked = await LOGIN.reserveLoginAttempt("VICTIM@example.com ", now + 10);
    assert.equal(locked.allowed, false, "case/space variants share the counter");
    assert.equal(locked.retryAfterMs, LOGIN.LOGIN_WINDOW_MS - 10);
    // A different email is unaffected.
    assert.equal((await LOGIN.reserveLoginAttempt("other@example.com", now + 11)).allowed, true);
    const all = await logins().find({}).toArray();
    assert.ok(all.every((d) => !JSON.stringify(d).includes("victim")), "plain email must not be stored");
    // After the window: allowed again.
    assert.equal((await LOGIN.reserveLoginAttempt("victim@example.com", now + LOGIN.LOGIN_WINDOW_MS)).allowed, true);
  });

  test("success resets the email counter and returns the global slot", async () => {
    const now = 1_900_400_000_000;
    for (let i = 0; i < 4; i++) {
      const r = await LOGIN.reserveLoginAttempt("user@example.com", now);
      await LOGIN.settleLoginAttempt(r.reservation, "failure");
    }
    const ok = await LOGIN.reserveLoginAttempt("user@example.com", now);
    assert.equal(ok.allowed, true);
    await LOGIN.settleLoginAttempt(ok.reservation, "success");
    assert.equal(await logins().countDocuments({ _id: LOGIN.loginAttemptId("user@example.com") }), 0);
    const global = await logins().findOne({ _id: "global" });
    assert.equal(global.failures, 4, "only the 4 failures stay on the global counter");
    for (let i = 0; i < 5; i++) {
      assert.equal((await LOGIN.reserveLoginAttempt("user@example.com", now)).allowed, true, `post-reset ${i + 1}`);
    }
  });

  test("'error' outcome refunds both counters", async () => {
    const now = 1_900_500_000_000;
    const r = await LOGIN.reserveLoginAttempt("err@example.com", now);
    await LOGIN.settleLoginAttempt(r.reservation, "error");
    assert.equal((await logins().findOne({ _id: LOGIN.loginAttemptId("err@example.com") })).failures, 0);
    assert.equal((await logins().findOne({ _id: "global" })).failures, 0);
  });

  test("global cap: after 100 failures any email is refused and its per-email slot is refunded", async () => {
    const now = 1_900_600_000_000;
    for (let i = 0; i < LOGIN.LOGIN_MAX_FAILURES_GLOBAL; i++) {
      const r = await LOGIN.reserveLoginAttempt(`spray${i}@example.com`, now);
      assert.equal(r.allowed, true, `spray ${i}`);
      await LOGIN.settleLoginAttempt(r.reservation, "failure");
    }
    const blocked = await LOGIN.reserveLoginAttempt("fresh@example.com", now + 5);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfterMs, LOGIN.LOGIN_WINDOW_MS - 5);
    const fresh = await logins().findOne({ _id: LOGIN.loginAttemptId("fresh@example.com") });
    assert.equal(fresh.failures, 0, "per-email slot refunded when the global cap refuses");
    assert.equal((await logins().findOne({ _id: "global" })).failures, 100);
  });

  test("CONCURRENCY: 20 parallel reservations for one fresh email -> exactly 5 allowed, no upsert errors", async () => {
    const now = 1_900_700_000_000;
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => LOGIN.reserveLoginAttempt("burst@example.com", now)),
    );
    const thrown = results.filter((r) => r.status === "rejected");
    assert.equal(thrown.length, 0, String(thrown[0]?.reason));
    assert.equal(results.filter((r) => r.value.allowed).length, 5);
    assert.equal((await logins().findOne({ _id: LOGIN.loginAttemptId("burst@example.com") })).failures, 5);
    assert.equal((await logins().findOne({ _id: "global" })).failures, 5);
  });

  test("CONCURRENCY: 150 parallel reservations across distinct emails -> global cap holds at 100", async () => {
    const now = 1_900_800_000_000;
    const results = await Promise.allSettled(
      Array.from({ length: 150 }, (_, i) => LOGIN.reserveLoginAttempt(`wide${i}@example.com`, now)),
    );
    assert.equal(results.filter((r) => r.status === "rejected").length, 0);
    assert.equal(results.filter((r) => r.value.allowed).length, 100);
    assert.equal((await logins().findOne({ _id: "global" })).failures, 100);
  });

  test("TTL index on expiresAt is created and expiresAt = windowStart + window", async () => {
    const now = 1_900_900_000_000;
    await LOGIN.reserveLoginAttempt("ttl@example.com", now);
    let ttl;
    for (let i = 0; i < 50 && !ttl; i++) {
      const idx = await logins().indexes();
      ttl = idx.find((x) => x.key?.expiresAt === 1);
      if (!ttl) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(ttl, "expected a TTL index on expiresAt");
    assert.equal(ttl.expireAfterSeconds, 0);
    const doc = await logins().findOne({ _id: LOGIN.loginAttemptId("ttl@example.com") });
    assert.equal(doc.windowStart, now);
    assert.equal(doc.expiresAt.getTime(), now + LOGIN.LOGIN_WINDOW_MS);
  });
});
