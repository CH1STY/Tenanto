// Tenant + unit server actions against a real MongoDB replica set.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  PREV,
  disconnect,
  fd,
  freshDatabase,
  load,
  makeBuildingFixture,
  makeStaff,
  makeTenant,
  nextNid,
  signInAs,
} from "./helpers/harness.mjs";

const T = load("src/app/(app)/admin/buildings/[buildingId]/tenants/actions.ts");
const L = load("src/app/(app)/admin/buildings/[buildingId]/ledger/actions.ts");
const B = load("src/app/(app)/admin/buildings/actions.ts");
const { monthRange, currentMonthYear } = load("src/lib/dates.ts");

let ctx;
let staff;
let A; // building the manager manages
let O; // other building the manager does NOT manage

before(async () => {
  ctx = await freshDatabase();
  A = await makeBuildingFixture({ name: "Tenant Tower A", units: ["1A", "1B", "2A", "2B", "3A"] });
  O = await makeBuildingFixture({ name: "Other Tower", units: ["1A", "1B"] });
  staff = await makeStaff([A.building._id]);
});
after(async () => {
  await disconnect();
});

const aid = () => String(A.building._id);
const oid = () => String(O.building._id);
const place = (buildingId, unitId, fields) =>
  T.placeTenant(PREV, fd({ buildingId, unitId: String(unitId), existingUserId: "", name: "", nid: "", phone: "", address: "", ...fields }));
const active = (unitId) => ctx.Tenancy.find({ unitId, isActive: true }).lean();

describe("placeTenant", () => {
  test("new tenant into a vacant unit (manager)", async () => {
    signInAs(staff.manager);
    const nid = nextNid();
    const res = await place(aid(), A.units[0]._id, { name: "Alice", nid, phone: "017" });
    assert.deepEqual(res, { error: null, ok: true });
    const user = await ctx.User.findOne({ nid }).lean();
    assert.equal(user.role, "TENANT");
    assert.equal(user.name, "Alice");
    const t = await active(A.units[0]._id);
    assert.equal(t.length, 1);
    assert.equal(String(t[0].userId), String(user._id));
    assert.equal(String(t[0].buildingId), aid());
  });

  test("blank NID is omitted so many tenants without NID can coexist", async () => {
    signInAs(staff.manager);
    assert.equal((await place(aid(), A.units[3]._id, { name: "NoNid 1" })).ok, true);
    assert.equal((await place(aid(), A.units[4]._id, { name: "NoNid 2" })).ok, true);
    const u = await ctx.User.findOne({ name: "NoNid 2" }).lean();
    assert.equal("nid" in u, false);
  });

  test("duplicate NID is refused and the transaction rolls back (occupant stays)", async () => {
    signInAs(staff.manager);
    const alice = await ctx.User.findOne({ name: "Alice" }).lean();
    const res = await place(aid(), A.units[0]._id, { name: "Imposter", nid: alice.nid });
    assert.equal(res.ok, false);
    assert.match(res.error, /already exists/);
    const t = await active(A.units[0]._id);
    assert.equal(t.length, 1);
    assert.equal(String(t[0].userId), String(alice._id), "occupant must not be ended on rollback");
    assert.equal(await ctx.User.countDocuments({ name: "Imposter" }), 0);
  });

  test("reassigning an occupied unit ends the previous tenancy (kept for history)", async () => {
    signInAs(staff.manager);
    const alice = await ctx.User.findOne({ name: "Alice" }).lean();
    assert.equal((await place(aid(), A.units[0]._id, { name: "Bob", nid: nextNid() })).ok, true);
    const t = await active(A.units[0]._id);
    assert.equal(t.length, 1);
    const old = await ctx.Tenancy.findOne({ userId: alice._id }).lean();
    assert.equal(old.isActive, false);
    assert.ok(old.endDate instanceof Date);
  });

  test("manager reuses an existing tenant with history in this building (moves, reactivates)", async () => {
    signInAs(staff.manager);
    const alice = await ctx.User.findOne({ name: "Alice" }).lean();
    await ctx.User.updateOne({ _id: alice._id }, { isActive: false });
    const res = await place(aid(), A.units[1]._id, { existingUserId: String(alice._id) });
    assert.deepEqual(res, { error: null, ok: true });
    const t = await active(A.units[1]._id);
    assert.equal(String(t[0].userId), String(alice._id));
    assert.equal((await ctx.User.findById(alice._id).lean()).isActive, true);
    assert.equal(await ctx.Tenancy.countDocuments({ userId: alice._id, isActive: true }), 1);
  });

  test("IDOR: manager cannot reuse a tenant who only has history in another building", async () => {
    const foreign = await makeTenant(O.building._id, O.units[0]._id, "Foreigner");
    signInAs(staff.manager);
    const res = await place(aid(), A.units[2]._id, { existingUserId: String(foreign.user._id) });
    assert.equal(res.error, "Selected tenant not found.");
    assert.equal((await ctx.Tenancy.findById(foreign.tenancy._id).lean()).isActive, true);
    assert.equal((await active(A.units[2]._id)).length, 0);
  });

  test("IDOR: manager cannot pull a tenant with history here who is now housed in another building", async () => {
    const wanderer = await makeTenant(A.building._id, A.units[2]._id, "Wanderer");
    await ctx.Tenancy.updateOne({ _id: wanderer.tenancy._id }, { isActive: false, endDate: new Date() });
    const elsewhere = await ctx.Tenancy.create({ buildingId: O.building._id, unitId: O.units[1]._id, userId: wanderer.user._id, isActive: true });
    signInAs(staff.manager);
    const res = await place(aid(), A.units[2]._id, { existingUserId: String(wanderer.user._id) });
    assert.match(res.error, /housed in another building/);
    assert.equal((await ctx.Tenancy.findById(elsewhere._id).lean()).isActive, true, "other building's tenancy must stay active");
    assert.equal((await active(A.units[2]._id)).length, 0);
  });

  test("SUPER_ADMIN can move a tenant housed in another building", async () => {
    const wanderer = await ctx.User.findOne({ name: "Wanderer" }).lean();
    signInAs(staff.superAdmin);
    const res = await place(aid(), A.units[2]._id, { existingUserId: String(wanderer._id) });
    assert.deepEqual(res, { error: null, ok: true });
    const all = await ctx.Tenancy.find({ userId: wanderer._id, isActive: true }).lean();
    assert.equal(all.length, 1);
    assert.equal(String(all[0].buildingId), aid());
    assert.equal(String(all[0].unitId), String(A.units[2]._id));
  });

  test("manager cannot place into a building they don't manage; unit must belong to the building", async () => {
    signInAs(staff.manager);
    assert.equal((await place(oid(), O.units[0]._id, { name: "X" })).error, "You do not manage this building.");
    assert.equal((await place(aid(), O.units[0]._id, { name: "X" })).error, "Unit not found in this building.");
    signInAs(null);
    assert.equal((await place(aid(), A.units[0]._id, { name: "X" })).error, "Not authorized.");
  });

  test("CONCURRENCY: two placements into the same VACANT unit never leave two active tenancies", async () => {
    const { building, units } = await makeBuildingFixture({ name: "Race Unit Tower", units: ["9Z"] });
    signInAs(staff.superAdmin);
    const results = await Promise.allSettled([
      place(String(building._id), units[0]._id, { name: "Racer 1", nid: nextNid() }),
      place(String(building._id), units[0]._id, { name: "Racer 2", nid: nextNid() }),
    ]);
    const t = await active(units[0]._id);
    assert.equal(
      t.length,
      1,
      `unit has ${t.length} active tenancies; results ${JSON.stringify(results.map((r) => r.value ?? String(r.reason)))}`,
    );
  });

  test("CONCURRENCY: two placements into the same OCCUPIED unit leave exactly one active tenancy", async () => {
    const { building, units } = await makeBuildingFixture({ name: "Race Occupied Tower", units: ["9Y"] });
    await makeTenant(building._id, units[0]._id, "Sitting");
    signInAs(staff.superAdmin);
    await Promise.allSettled([
      place(String(building._id), units[0]._id, { name: "Racer 3", nid: nextNid() }),
      place(String(building._id), units[0]._id, { name: "Racer 4", nid: nextNid() }),
    ]);
    assert.equal((await active(units[0]._id)).length, 1);
  });
});

describe("tenant charges: payTenantCharge / addManualCharge / deleteCharge", () => {
  let C; // building with its own months
  let tenant;
  before(async () => {
    C = await makeBuildingFixture({ name: "Charge Tower", units: ["1A", "1B"] });
    await ctx.User.updateOne({ _id: staff.manager._id }, { $push: { managedBuildingIds: C.building._id } });
    tenant = await makeTenant(C.building._id, C.units[0]._id, "Payer");
    signInAs(staff.superAdmin);
    assert.equal((await L.openMonth(PREV, fd({ buildingId: String(C.building._id), monthYear: "2026-01", serviceChargeAmount: 500 }))).ok, true);
  });
  const cid = () => String(C.building._id);
  const manual = (monthYear, extra = {}) =>
    T.addManualCharge(PREV, fd({ buildingId: cid(), userId: String(tenant.user._id), category: "BILL", monthYear, description: "Gas", amount: "75.5", ...extra }));
  const payT = (monthYear, chargeId, amount, extra = {}) =>
    T.payTenantCharge(PREV, fd({ buildingId: cid(), monthYear, chargeId: String(chargeId), amount, ...extra }));

  test("payTenantCharge without a date stamps receivedAt inside the (past) month", async () => {
    signInAs(staff.manager);
    const sc = await ctx.Charge.findOne({ buildingId: C.building._id, category: "SERVICE_CHARGE" }).lean();
    assert.deepEqual(await payT("2026-01", sc._id, "100"), { error: null, ok: true });
    const p = await ctx.Payment.findOne({ "allocations.chargeId": sc._id }).lean();
    const { start, end } = monthRange("2026-01");
    assert.ok(p.receivedAt >= start && p.receivedAt <= end, p.receivedAt.toISOString());
    assert.equal(p.monthYear, "2026-01");
    assert.equal((await ctx.Charge.findById(sc._id).lean()).paidAmount, 100);
  });

  test("payTenantCharge with explicit date: inside accepted, outside rejected; overpay rejected", async () => {
    signInAs(staff.manager);
    const sc = await ctx.Charge.findOne({ buildingId: C.building._id, category: "SERVICE_CHARGE" }).lean();
    assert.equal((await payT("2026-01", sc._id, "50", { date: "2026-01-31" })).ok, true);
    const p = await ctx.Payment.findOne({ "allocations.chargeId": sc._id, totalAmount: 50 }).lean();
    assert.equal(p.receivedAt.toISOString(), "2026-01-31T12:00:00.000Z");
    assert.match((await payT("2026-01", sc._id, "10", { date: "2025-12-31" })).error, /within January 2026/);
    assert.match((await payT("2026-01", sc._id, "350.01")).error, /exceeds the outstanding 350/);
  });

  test("CONCURRENCY: payTenantCharge 10 x 100 on 350 outstanding -> 3 succeed", async () => {
    signInAs(staff.manager);
    const sc = await ctx.Charge.findOne({ buildingId: C.building._id, category: "SERVICE_CHARGE" }).lean();
    const r = await Promise.all(Array.from({ length: 10 }, () => payT("2026-01", sc._id, "100")));
    assert.equal(r.filter((x) => x.ok).length, 3);
    const c = await ctx.Charge.findById(sc._id).lean();
    const pays = await ctx.Payment.find({ "allocations.chargeId": sc._id }).lean();
    assert.equal(c.paidAmount, 450);
    assert.equal(pays.reduce((s, p) => s + p.allocations[0].amount, 0), 450);
    assert.equal(c.status, "PARTIAL");
  });

  test("payTenantCharge in the CURRENT month stamps a time inside that month", async () => {
    const D = await makeBuildingFixture({ name: "Current Month Tower", units: ["1A"] });
    const t = await makeTenant(D.building._id, D.units[0]._id, "Now");
    signInAs(staff.superAdmin);
    const now = currentMonthYear();
    await L.openMonth(PREV, fd({ buildingId: String(D.building._id), monthYear: now, serviceChargeAmount: 100 }));
    const sc = await ctx.Charge.findOne({ tenancyId: t.tenancy._id }).lean();
    const res = await T.payTenantCharge(PREV, fd({ buildingId: String(D.building._id), monthYear: now, chargeId: String(sc._id), amount: "10" }));
    assert.equal(res.ok, true);
    const p = await ctx.Payment.findOne({ "allocations.chargeId": sc._id }).lean();
    const { start, end } = monthRange(now);
    assert.ok(p.receivedAt >= start && p.receivedAt <= end);
    assert.ok(Math.abs(p.receivedAt.getTime() - Date.now()) < 60_000, "should be 'now'");
  });

  test("addManualCharge: OK in the open month; refused for unopened month; tenant needs a tenancy here", async () => {
    signInAs(staff.manager);
    assert.deepEqual(await manual("2026-01"), { error: null, ok: true });
    const c = await ctx.Charge.findOne({ buildingId: C.building._id, description: "Gas" }).lean();
    assert.equal(c.amount, 75.5);
    assert.equal(String(c.tenancyId), String(tenant.tenancy._id));
    assert.match((await manual("2026-02")).error, /Month 2026-02 is not open/);
    const stranger = await ctx.User.create({ name: "Stranger", nid: nextNid(), role: "TENANT" });
    const r = await T.addManualCharge(PREV, fd({ buildingId: cid(), userId: String(stranger._id), category: "BILL", monthYear: "2026-01", description: "x", amount: "1" }));
    assert.equal(r.error, "Assign this tenant to a unit before adding dues.");
  });

  test("deleteCharge: removes an unpaid manual due in an OPEN month; refuses service charges and paid dues; MANAGER refused", async () => {
    signInAs(staff.manager);
    const gas = await ctx.Charge.findOne({ buildingId: C.building._id, description: "Gas" }).lean();
    await assert.rejects(T.deleteCharge(fd({ buildingId: cid(), chargeId: String(gas._id) })), /FORBIDDEN/);
    assert.ok(await ctx.Charge.exists({ _id: gas._id }));

    signInAs(staff.superAdmin);
    const sc = await ctx.Charge.findOne({ buildingId: C.building._id, category: "SERVICE_CHARGE" }).lean();
    await T.deleteCharge(fd({ buildingId: cid(), chargeId: String(sc._id) }));
    assert.ok(await ctx.Charge.exists({ _id: sc._id }), "service charge must not be deletable");

    await manual("2026-01", { description: "Paid due" });
    const paidDue = await ctx.Charge.findOne({ description: "Paid due" }).lean();
    assert.equal((await payT("2026-01", paidDue._id, "1")).ok, true);
    await T.deleteCharge(fd({ buildingId: cid(), chargeId: String(paidDue._id) }));
    assert.ok(await ctx.Charge.exists({ _id: paidDue._id }), "paid due must not be deletable");

    await T.deleteCharge(fd({ buildingId: cid(), chargeId: String(gas._id) }));
    assert.equal(await ctx.Charge.exists({ _id: gas._id }), null);
  });

  test("after closing the month: addManualCharge / payTenantCharge / deleteCharge are refused", async () => {
    signInAs(staff.superAdmin);
    await manual("2026-01", { description: "Late gas" });
    const late = await ctx.Charge.findOne({ description: "Late gas" }).lean();
    await L.closeMonth(fd({ buildingId: cid(), monthYear: "2026-01" }));
    assert.equal((await ctx.MonthlyPeriod.findOne({ buildingId: C.building._id }).lean()).status, "CLOSED");
    assert.equal((await manual("2026-01")).error, "Month 2026-01 is closed.");
    assert.equal((await payT("2026-01", late._id, "1")).error, "Month 2026-01 is closed.");
    await T.deleteCharge(fd({ buildingId: cid(), chargeId: String(late._id) }));
    assert.ok(await ctx.Charge.exists({ _id: late._id }), "a due in a CLOSED month must not be deletable");
  });
});

describe("vacateUnit", () => {
  test("manager vacates a unit in a managed building; cannot vacate in another building", async () => {
    signInAs(staff.manager);
    const before = await active(A.units[1]._id);
    assert.equal(before.length, 1);
    await T.vacateUnit(fd({ unitId: String(A.units[1]._id) }));
    assert.equal((await active(A.units[1]._id)).length, 0);
    const ended = await ctx.Tenancy.findById(before[0]._id).lean();
    assert.equal(ended.isActive, false);
    assert.ok(ended.endDate);

    const foreign = await active(O.units[0]._id);
    assert.equal(foreign.length, 1);
    await T.vacateUnit(fd({ unitId: String(O.units[0]._id) }));
    assert.equal((await active(O.units[0]._id)).length, 1, "manager must not vacate a unit in another building");
  });
});

describe("deleteUnit (admin/buildings/actions.ts)", () => {
  test("refused with a message when the unit has (past) tenancy history", async () => {
    signInAs(staff.superAdmin);
    // A.units[1] was vacated above: no active tenancy, only history.
    const res = await B.deleteUnit(PREV, fd({ unitId: String(A.units[1]._id) }));
    assert.equal(res.ok, undefined);
    assert.match(res.error, /has tenant history, so it can't be deleted/);
    assert.ok(await ctx.Unit.exists({ _id: A.units[1]._id }));
  });

  test("succeeds for a unit that never had a tenancy; then 'no longer exists'", async () => {
    signInAs(staff.superAdmin);
    const fresh = await ctx.Unit.create({ buildingId: A.building._id, floorNumber: 5, label: "5Z" });
    assert.deepEqual(await B.deleteUnit(PREV, fd({ unitId: String(fresh._id) })), { error: null, ok: true });
    assert.equal(await ctx.Unit.exists({ _id: fresh._id }), null);
    assert.equal((await B.deleteUnit(PREV, fd({ unitId: String(fresh._id) }))).error, "This unit no longer exists.");
    assert.equal((await B.deleteUnit(PREV, fd({ unitId: "nope" }))).error, "Invalid unit.");
    assert.ok(await ctx.AuditLog.exists({ entity: "Unit", action: "DELETE", entityId: String(fresh._id) }));
  });

  test("MANAGER is refused with an {error} (ConfirmActionForm shows it), not a thrown FORBIDDEN", async () => {
    signInAs(staff.manager);
    const fresh = await ctx.Unit.create({ buildingId: A.building._id, floorNumber: 5, label: "5Y" });
    const res = await B.deleteUnit(PREV, fd({ unitId: String(fresh._id) }));
    assert.equal(res.error, "Only a Super Admin can delete units.");
    assert.notEqual(res.ok, true);
    assert.ok(await ctx.Unit.exists({ _id: fresh._id }));
    assert.equal(await ctx.AuditLog.exists({ entity: "Unit", action: "DELETE", entityId: String(fresh._id) }), null);
  });
});
