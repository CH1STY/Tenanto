// building-transfer export/import and scripts/check-data.mjs against a real
// MongoDB replica set (tenant_itest only).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import {
  ITEST_URI,
  PREV,
  assertSafeUri,
  disconnect,
  fd,
  freshDatabase,
  load,
  makeBuildingFixture,
  makeStaff,
  makeTenant,
  root,
  signInAs,
} from "./helpers/harness.mjs";

const { EJSON } = createRequire(import.meta.url)("mongodb").BSON;
const L = load("src/app/(app)/admin/buildings/[buildingId]/ledger/actions.ts");
const T = load("src/app/(app)/admin/buildings/[buildingId]/tenants/actions.ts");
const X = load("src/lib/building-transfer.ts");

let ctx;
let staff;
let src; // the source building fixture

before(async () => {
  ctx = await freshDatabase();
  src = await makeBuildingFixture({ name: "Export Tower", units: ["1A", "1B", "2A"] });
  staff = await makeStaff([src.building._id]);
  await buildLedger();
});
after(async () => {
  await disconnect();
});

const ok = (r) => assert.deepEqual(r, { error: null, ok: true });

/** A small but complete, internally consistent ledger built through the real actions. */
async function buildLedger() {
  const bid = String(src.building._id);
  const m = (monthYear) => ({ buildingId: bid, monthYear });
  const t0 = await makeTenant(src.building._id, src.units[0]._id, "Exporter Zero");
  const t1 = await makeTenant(src.building._id, src.units[1]._id, "Exporter One");
  signInAs(staff.superAdmin);
  ok(await L.openMonth(PREV, fd({ ...m("2026-01"), serviceChargeAmount: 800, openingBalance: 1000 })));
  ok(await L.addCharge(PREV, fd({ ...m("2026-01"), tenancyId: String(t0.tenancy._id), category: "BILL", description: "Electric", amount: "300" })));
  const bill = await ctx.Charge.findOne({ buildingId: bid, description: "Electric" }).lean();
  // Two adjustments in January.
  ok(await L.editCharge(PREV, fd({ ...m("2026-01"), chargeId: String(bill._id), description: "Electric (fixed)", amount: "320" })));
  ok(await L.editCharge(PREV, fd({ ...m("2026-01"), chargeId: String(bill._id), description: "Electric (final)", amount: "310.5" })));
  ok(await L.recordPayment(PREV, fd({ ...m("2026-01"), chargeId: String(bill._id), amount: "100" })));
  const [sc0] = await ctx.Charge.find({ buildingId: bid, monthYear: "2026-01", tenancyId: t0.tenancy._id, category: "SERVICE_CHARGE" }).lean();
  ok(await L.recordPayment(PREV, fd({ ...m("2026-01"), chargeId: String(sc0._id), amount: "800" })));
  ok(await L.addIncome(PREV, fd({ ...m("2026-01"), source: "ROOFTOP_RENT", description: "Roof", amount: "250" })));
  ok(await L.addExpense(PREV, fd({ ...m("2026-01"), category: "Repair", description: "Lift", amount: "400", status: "DUE" })));
  ok(await L.addWithdrawal(PREV, fd({ ...m("2026-01"), takenBy: "Owner", amount: "200", note: "advance" })));
  await L.closeMonth(fd(m("2026-01")));
  ok(await L.openMonth(PREV, fd({ ...m("2026-02"), serviceChargeAmount: 800 })));
  // Feb: settle part of Jan's bill (with a February adjustment), pay Jan's expense, return part of the withdrawal.
  ok(await L.editCharge(PREV, fd({ ...m("2026-02"), chargeId: String(bill._id), description: "Electric (feb)", amount: "305" })));
  ok(await L.recordPayment(PREV, fd({ ...m("2026-02"), chargeId: String(bill._id), amount: "50" })));
  const lift = await ctx.Expense.findOne({ buildingId: bid, description: "Lift" }).lean();
  ok(await L.payExpense(PREV, fd({ ...m("2026-02"), id: String(lift._id), amount: "150" })));
  const wd = await ctx.Withdrawal.findOne({ buildingId: bid }).lean();
  ok(await L.returnWithdrawal(PREV, fd({ ...m("2026-02"), id: String(wd._id), amount: "75" })));
  ok(await T.addManualCharge(PREV, fd({ buildingId: bid, userId: String(t1.user._id), category: "PREVIOUS_DUE", monthYear: "2026-02", description: "Old balance", amount: "99.99" })));
  const febPeriod = await ctx.MonthlyPeriod.findOne(m("2026-02")).lean();
  await ctx.MonthMedia.create({
    buildingId: src.building._id,
    periodId: febPeriod._id,
    monthYear: "2026-02",
    data: Buffer.from("fake-jpeg-bytes"),
    contentType: "image/jpeg",
    filename: "receipt.jpg",
    size: 15,
  });
}

// ---------------------------------------------------------------------------
// building-transfer
// ---------------------------------------------------------------------------

describe("building-transfer export/import", () => {
  let exported;
  let imported;
  let newId;

  test("export -> JSON file round trip -> import creates a new self-consistent building", async () => {
    exported = await X.exportBuilding(String(src.building._id));
    assert.equal(exported.version, X.BUILDING_EXPORT_VERSION);
    const fileJson = JSON.parse(JSON.stringify(exported)); // what the user downloads/uploads
    const res = await X.importBuilding(fileJson, String(staff.superAdmin._id));
    assert.equal(res.ok, true, res.error);
    newId = res.buildingId;
    assert.notEqual(newId, String(src.building._id));
    imported = await X.exportBuilding(newId);
    for (const key of ["units", "users", "tenancies", "periods", "charges", "payments", "incomes", "expenses", "withdrawals", "media"]) {
      assert.equal(imported[key].length, exported[key].length, `${key} count`);
    }
  });

  test("charge adjustments survive the round trip (values, order, months, dates)", async () => {
    const strip = (a) => ({ ...a, at: new Date(a.at).toISOString() });
    const byDesc = (list) => new Map(list.map((c) => [`${c.monthYear}|${c.category}|${c.description}|${c.amount}`, c]));
    const before = byDesc(exported.charges);
    const afterMap = byDesc(imported.charges);
    let withAdjustments = 0;
    for (const [key, c] of before) {
      const twin = afterMap.get(key);
      assert.ok(twin, `missing imported charge ${key}`);
      assert.deepEqual((twin.adjustments ?? []).map(strip), (c.adjustments ?? []).map(strip), key);
      assert.equal(twin.paidAmount, c.paidAmount);
      assert.equal(twin.status, c.status);
      assert.equal(twin.carriedFrom ?? null, c.carriedFrom ?? null);
      if ((c.adjustments ?? []).length) withAdjustments += 1;
    }
    assert.equal(withAdjustments, 1);
    const elec = imported.charges.find((c) => c.description === "Electric (feb)");
    assert.deepEqual(
      elec.adjustments.map((a) => [a.monthYear, a.prevAmount, a.amount, a.prevDescription, a.description, a.by]),
      [
        ["2026-01", 300, 320, "Electric", "Electric (fixed)", "Super Admin"],
        ["2026-01", 320, 310.5, "Electric (fixed)", "Electric (final)", "Super Admin"],
        ["2026-02", 310.5, 305, "Electric (final)", "Electric (feb)", "Super Admin"],
      ],
    );
  });

  test("every id is fresh and every cross-reference is remapped inside the new building", async () => {
    const oldIds = new Set();
    for (const key of ["units", "users", "tenancies", "periods", "charges", "payments", "incomes", "expenses", "withdrawals", "media"]) {
      for (const d of exported[key]) oldIds.add(String(d._id));
    }
    const ids = (key) => new Set(imported[key].map((d) => String(d._id)));
    const units = ids("units");
    const users = ids("users");
    const tenancies = ids("tenancies");
    const charges = ids("charges");
    const periods = ids("periods");
    for (const key of ["units", "users", "tenancies", "periods", "charges", "payments", "incomes", "expenses", "withdrawals", "media"]) {
      for (const d of imported[key]) {
        assert.ok(!oldIds.has(String(d._id)), `${key} ${d._id} reused an old id`);
        if (key !== "users") assert.equal(String(d.buildingId), newId, `${key} buildingId`);
      }
    }
    for (const t of imported.tenancies) {
      assert.ok(units.has(String(t.unitId)), "tenancy.unitId remapped");
      assert.ok(users.has(String(t.userId)), "tenancy.userId remapped");
    }
    for (const c of imported.charges) {
      assert.ok(tenancies.has(String(c.tenancyId)), "charge.tenancyId remapped");
      assert.ok(users.has(String(c.userId)), "charge.userId remapped");
    }
    for (const p of imported.payments) {
      assert.ok(tenancies.has(String(p.tenancyId)));
      assert.ok(users.has(String(p.userId)));
      assert.ok(p.allocations.length > 0, "allocations must not be dropped");
      for (const a of p.allocations) assert.ok(charges.has(String(a.chargeId)), "allocation.chargeId remapped");
    }
    for (const p of imported.periods) {
      for (const r of p.roster) {
        assert.ok(tenancies.has(String(r.tenancyId)) && users.has(String(r.userId)) && units.has(String(r.unitId)));
      }
      assert.equal(p.roster.length, exported.periods.find((x) => x.monthYear === p.monthYear).roster.length);
    }
    for (const m of imported.media) {
      assert.ok(periods.has(String(m.periodId)), "media.periodId remapped");
      assert.equal(Buffer.from(m.data, "base64").toString(), "fake-jpeg-bytes");
    }
    // Paid totals still equal the allocations in the imported building.
    for (const c of imported.charges) {
      const alloc = imported.payments
        .flatMap((p) => p.allocations)
        .filter((a) => String(a.chargeId) === String(c._id))
        .reduce((s, a) => s + a.amount, 0);
      assert.ok(Math.abs(alloc - c.paidAmount) < 1e-6, `charge ${c.description}: ${alloc} vs ${c.paidAmount}`);
    }
    // Balances carried over.
    const jan = imported.periods.find((p) => p.monthYear === "2026-01");
    const janOld = exported.periods.find((p) => p.monthYear === "2026-01");
    assert.equal(jan.closingBalance, janOld.closingBalance);
    assert.equal(jan.status, "CLOSED");
    // Source building untouched.
    assert.equal(await ctx.Charge.countDocuments({ buildingId: src.building._id }), exported.charges.length);
  });
});

// ---------------------------------------------------------------------------
// scripts/check-data.mjs
// ---------------------------------------------------------------------------

function runCheckData() {
  assertSafeUri(ITEST_URI);
  const env = { ...process.env, MONGODB_URI: ITEST_URI };
  const out = spawnSync(process.execPath, [path.join(root, "scripts", "check-data.mjs")], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
  const sections = {};
  for (const m of out.stdout.matchAll(/^=== (\d+[a-d]?)\. .*? — (\d+) found$/gm)) sections[m[1]] = Number(m[2]);
  const total = Number(/Total problems \(excluding informational\): (\d+)/.exec(out.stdout)?.[1]);
  return { ...out, sections, total };
}

/** Collections, indexes and a hash of every document. */
async function snapshot() {
  const db = ctx.db;
  const cols = (await db.listCollections().toArray()).map((c) => c.name).sort();
  const result = { collections: cols, data: {} };
  for (const name of cols) {
    const docs = await db.collection(name).find({}).sort({ _id: 1 }).toArray();
    const indexes = (await db.collection(name).indexes()).map((i) => i.name).sort();
    result.data[name] = {
      count: docs.length,
      hash: createHash("sha256").update(EJSON.stringify(docs, { relaxed: false })).digest("hex"),
      indexes,
    };
  }
  return result;
}

describe("scripts/check-data.mjs", () => {
  test("clean fixtures: exit 0, zero problems, and nothing written", async () => {
    const before = await snapshot();
    const r = runCheckData();
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /Target host: localhost:27018  database: tenant_itest/);
    assert.equal(r.total, 0, r.stdout);
    assert.ok(!/itest\.local|password/i.test(r.stdout), "no credentials / emails printed");
    assert.deepEqual(await snapshot(), before);
  });

  test("deliberate orphans are reported in the right sections; still read-only", async () => {
    const { Types } = ctx.conn;
    const bid = src.building._id;
    const tenancy = await ctx.Tenancy.findOne({ buildingId: bid }).lean();
    const missingCharge = new Types.ObjectId();
    const missingUnit = new Types.ObjectId();
    await ctx.db.collection("payments").insertOne({
      buildingId: bid,
      tenancyId: tenancy._id,
      userId: tenancy.userId,
      monthYear: "2026-02",
      totalAmount: 42,
      allocations: [{ chargeId: missingCharge, category: "BILL", amount: 42 }],
      receivedAt: new Date("2026-02-10T12:00:00Z"),
    });
    await ctx.db.collection("tenancies").insertOne({
      buildingId: bid,
      unitId: missingUnit,
      userId: tenancy.userId,
      startDate: new Date(),
      endDate: new Date(),
      isActive: false,
    });
    const drifted = await ctx.Charge.findOne({ buildingId: bid, description: "Old balance" }).lean();
    // paidAmount 7 with no payments behind it (status kept consistent with 7/99.99).
    await ctx.db.collection("charges").updateOne({ _id: drifted._id }, { $set: { paidAmount: 7, status: "PARTIAL" } });
    // Drop a collection to prove the script never re-creates it.
    await ctx.db.collection("auditlogs").drop();

    const before = await snapshot();
    const r = runCheckData();
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(r.sections["1"], 1, "dangling allocation");
    assert.match(r.stdout, new RegExp(`missing Charge ${missingCharge}`));
    assert.equal(r.sections["2a"], 1, "tenancy -> missing unit");
    assert.match(r.stdout, new RegExp(`missing Unit ${missingUnit}`));
    assert.equal(r.sections["6a"], 1, "paidAmount drift");
    assert.match(r.stdout, new RegExp(`Charge ${drifted._id} .*paidAmount 7.00 vs allocations 0.00`));
    assert.equal(r.sections["2b"], 0);
    assert.equal(r.sections["7"], 0);
    assert.equal(r.total, 3, r.stdout);
    const afterSnap = await snapshot();
    assert.deepEqual(afterSnap, before, "check-data must not write anything");
    assert.ok(!afterSnap.collections.includes("auditlogs"), "dropped collection must not be re-created");
  });

  test("refuses to start without MONGODB_URI", () => {
    const env = { ...process.env };
    delete env.MONGODB_URI;
    const out = spawnSync(process.execPath, [path.join(root, "scripts", "check-data.mjs")], { cwd: root, env, encoding: "utf8" });
    assert.equal(out.status, 1);
    assert.match(out.stderr, /MONGODB_URI is not set/);
  });
});
