// Ledger server actions against a real MongoDB replica set.
// Run with `npm run test:integration` (needs the tenant-test-mongo container).
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
  signInAs,
} from "./helpers/harness.mjs";

const L = load("src/app/(app)/admin/buildings/[buildingId]/ledger/actions.ts");
const { getPeriodTotals, computeClosing } = load("src/lib/ledger.ts");
const { monthRange } = load("src/lib/dates.ts");

let ctx;
let staff;

before(async () => {
  ctx = await freshDatabase();
});
after(async () => {
  await disconnect();
});

const round2 = (n) => Math.round(n * 100) / 100;

async function setup({ name, tenants = 3 }) {
  const { building, units } = await makeBuildingFixture({ name });
  // One SuperAdmin + one Manager for the whole file; the manager is assigned
  // every building created here.
  staff ??= await makeStaff([]);
  await ctx.User.updateOne({ _id: staff.manager._id }, { $push: { managedBuildingIds: building._id } });
  const ts = [];
  for (let i = 0; i < tenants; i++) {
    ts.push(await makeTenant(building._id, units[i]._id, `T${i}`));
  }
  return { building, units, bid: String(building._id), tenants: ts };
}

async function openMonth(bid, monthYear, extra = {}) {
  signInAs(staff.superAdmin);
  return L.openMonth(PREV, fd({ buildingId: bid, monthYear, serviceChargeAmount: 1000, ...extra }));
}
async function closeMonth(bid, monthYear) {
  signInAs(staff.superAdmin);
  return L.closeMonth(fd({ buildingId: bid, monthYear }));
}
async function reopenMonth(bid, monthYear) {
  signInAs(staff.superAdmin);
  return L.reopenMonth(fd({ buildingId: bid, monthYear }));
}
async function chargesFor(bid, monthYear) {
  return ctx.Charge.find({ buildingId: bid, monthYear }).sort({ _id: 1 }).lean();
}

/** Invariants for one charge against the Payment collection. */
async function assertChargeConsistent(chargeId) {
  const charge = await ctx.Charge.findById(chargeId).lean();
  const payments = await ctx.Payment.find({ "allocations.chargeId": chargeId }).lean();
  const allocated = payments
    .flatMap((p) => p.allocations)
    .filter((a) => String(a.chargeId) === String(chargeId))
    .reduce((s, a) => s + a.amount, 0);
  assert.ok(charge.paidAmount <= charge.amount + 1e-6, `overpaid: ${charge.paidAmount} > ${charge.amount}`);
  assert.ok(Math.abs(allocated - charge.paidAmount) < 1e-6, `allocations ${allocated} != paidAmount ${charge.paidAmount}`);
  const want = charge.paidAmount <= 0 ? "DUE" : charge.paidAmount + 1e-6 >= charge.amount ? "PAID" : "PARTIAL";
  assert.equal(charge.status, want);
  return { charge, payments, allocated };
}

describe("openMonth", () => {
  let f;
  before(async () => {
    f = await setup({ name: "Open Tower" });
  });

  test("a MANAGER cannot open a month", async () => {
    signInAs(staff.manager);
    const res = await L.openMonth(PREV, fd({ buildingId: f.bid, monthYear: "2026-01", serviceChargeAmount: 1000 }));
    assert.equal(res.ok, false);
    assert.match(res.error, /Super Admin/);
    assert.equal(await ctx.MonthlyPeriod.countDocuments({ buildingId: f.bid }), 0);
  });

  test("SUPER_ADMIN opens a month: roster snapshot + one service charge per active tenancy", async () => {
    const res = await openMonth(f.bid, "2026-01", { openingBalance: 500 });
    assert.deepEqual(res, { error: null, ok: true });
    const period = await ctx.MonthlyPeriod.findOne({ buildingId: f.bid, monthYear: "2026-01" }).lean();
    assert.equal(period.status, "OPEN");
    assert.equal(period.openingBalance, 500);
    assert.equal(period.roster.length, 3);
    assert.deepEqual(period.roster.map((r) => r.tenantName).sort(), ["T0", "T1", "T2"]);
    const charges = await chargesFor(f.bid, "2026-01");
    assert.equal(charges.length, 3);
    for (const c of charges) {
      assert.equal(c.category, "SERVICE_CHARGE");
      assert.equal(c.amount, 1000);
      assert.equal(c.status, "DUE");
    }
  });

  test("a second month cannot be opened while one is open; the same month cannot be reopened", async () => {
    const other = await openMonth(f.bid, "2026-02");
    assert.equal(other.ok, false);
    assert.match(other.error, /only one month can be open/);
    const same = await openMonth(f.bid, "2026-01");
    assert.equal(same.ok, false);
    assert.match(same.error, /already been opened/);
  });

  test("CONCURRENCY: two different months opened in parallel never leave two OPEN months", async () => {
    const g = await setup({ name: "Race Open Tower", tenants: 1 });
    const results = await Promise.allSettled([
      openMonth(g.bid, "2026-03"),
      openMonth(g.bid, "2026-04"),
      openMonth(g.bid, "2026-05"),
    ]);
    const open = await ctx.MonthlyPeriod.find({ buildingId: g.bid, status: "OPEN" }).lean();
    assert.equal(
      open.length,
      1,
      `expected one OPEN month, found ${open.map((p) => p.monthYear).join(", ")}; results: ${JSON.stringify(
        results.map((r) => r.value ?? String(r.reason)),
      )}`,
    );
  });

  test("CONCURRENCY: the same month opened twice in parallel returns an {error}, not an exception", async () => {
    const g = await setup({ name: "Race Same Month", tenants: 2 });
    const results = await Promise.allSettled([openMonth(g.bid, "2026-03"), openMonth(g.bid, "2026-03")]);
    const thrown = results.filter((r) => r.status === "rejected").map((r) => String(r.reason?.message ?? r.reason));
    assert.equal(await ctx.MonthlyPeriod.countDocuments({ buildingId: g.bid }), 1);
    assert.equal(await ctx.Charge.countDocuments({ buildingId: g.bid }), 2, "no duplicate service charges");
    assert.deepEqual(thrown, [], "a losing racer should get a friendly {error}");
  });
});

describe("recordPayment", () => {
  let f;
  let charges;
  before(async () => {
    f = await setup({ name: "Pay Tower" });
    assert.equal((await openMonth(f.bid, "2026-01")).ok, true);
    charges = await chargesFor(f.bid, "2026-01");
  });
  const pay = (chargeId, amount, extra = {}) =>
    L.recordPayment(PREV, fd({ buildingId: f.bid, monthYear: "2026-01", chargeId: String(chargeId), amount, ...extra }));

  test("normal path: partial then full; receivedAt inside the month; audit row written", async () => {
    signInAs(staff.manager);
    assert.deepEqual(await pay(charges[0]._id, "400"), { error: null, ok: true });
    let { charge } = await assertChargeConsistent(charges[0]._id);
    assert.equal(charge.paidAmount, 400);
    assert.equal(charge.status, "PARTIAL");
    assert.deepEqual(await pay(charges[0]._id, "600", { date: "2026-01-15" }), { error: null, ok: true });
    ({ charge } = await assertChargeConsistent(charges[0]._id));
    assert.equal(charge.status, "PAID");
    const payments = await ctx.Payment.find({ "allocations.chargeId": charges[0]._id }).lean();
    const { start, end } = monthRange("2026-01");
    for (const p of payments) {
      assert.ok(p.receivedAt >= start && p.receivedAt <= end, `receivedAt ${p.receivedAt.toISOString()}`);
      assert.equal(String(p.recordedBy), String(staff.manager._id));
      assert.equal(p.totalAmount, p.allocations[0].amount);
    }
    assert.ok(await ctx.AuditLog.exists({ entity: "Payment", buildingId: f.bid }));
  });

  test("overpay is rejected and changes nothing", async () => {
    signInAs(staff.manager);
    const res = await pay(charges[0]._id, "0.01");
    assert.equal(res.ok, false);
    assert.match(res.error, /exceeds the outstanding 0/);
    const res2 = await pay(charges[1]._id, "1000.01");
    // Formatted with toLocaleString (grouping separator).
    assert.match(res2.error, /exceeds the outstanding 1,000 on this charge/);
    const { charge } = await assertChargeConsistent(charges[1]._id);
    assert.equal(charge.paidAmount, 0);
    assert.equal(charge.status, "DUE");
  });

  test("date outside the month is rejected", async () => {
    signInAs(staff.manager);
    const res = await pay(charges[1]._id, "10", { date: "2026-02-01" });
    assert.match(res.error, /within January 2026/);
  });

  test("a manager of another building is refused", async () => {
    const outsider = await ctx.User.create({ name: "Other Mgr", email: "other-mgr@itest.local", role: "MANAGER", managedBuildingIds: [] });
    signInAs(outsider);
    const res = await pay(charges[1]._id, "10");
    assert.equal(res.error, "You do not manage this building.");
    signInAs(null);
    assert.equal((await pay(charges[1]._id, "10")).error, "Not authorized.");
  });

  test("a charge from another building cannot be paid through this building", async () => {
    const g = await setup({ name: "Foreign Tower", tenants: 1 });
    await openMonth(g.bid, "2026-01");
    const [foreign] = await chargesFor(g.bid, "2026-01");
    signInAs(staff.superAdmin);
    const res = await pay(foreign._id, "10");
    assert.equal(res.error, "Charge not found.");
    assert.equal((await ctx.Charge.findById(foreign._id).lean()).paidAmount, 0);
  });

  test("CONCURRENCY: 10 parallel payments of 150 on a 1000 charge -> exactly 6 succeed", async () => {
    signInAs(staff.manager);
    const target = charges[1]._id;
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => pay(target, "150")));
    const thrown = results.filter((r) => r.status === "rejected");
    assert.equal(thrown.length, 0, String(thrown[0]?.reason));
    const ok = results.filter((r) => r.value.ok).length;
    assert.equal(ok, 6);
    for (const r of results.filter((r) => !r.value.ok)) assert.match(r.value.error, /exceeds the outstanding 100/);
    const { charge, payments } = await assertChargeConsistent(target);
    assert.equal(charge.paidAmount, 900);
    assert.equal(payments.length, 6);
    assert.equal(charge.status, "PARTIAL");
  });

  test("CONCURRENCY: 10 parallel payments of 250 -> exactly 4 succeed and the charge is PAID", async () => {
    signInAs(staff.superAdmin);
    const target = charges[2]._id;
    const results = await Promise.all(Array.from({ length: 10 }, () => pay(target, "250")));
    assert.equal(results.filter((r) => r.ok).length, 4);
    const { charge } = await assertChargeConsistent(target);
    assert.equal(charge.paidAmount, 1000);
    assert.equal(charge.status, "PAID");
  });

  test("CONCURRENCY with float cents: 10 x 0.1 on a 0.3 bill -> 3 succeed, PAID, no drift", async () => {
    signInAs(staff.superAdmin);
    const res = await L.addCharge(
      PREV,
      fd({ buildingId: f.bid, monthYear: "2026-01", tenancyId: String(f.tenants[0].tenancy._id), category: "BILL", description: "Tiny", amount: "0.3" }),
    );
    assert.equal(res.ok, true);
    const bill = await ctx.Charge.findOne({ buildingId: f.bid, description: "Tiny" }).lean();
    const results = await Promise.all(Array.from({ length: 10 }, () => pay(bill._id, "0.1")));
    assert.equal(results.filter((r) => r.ok).length, 3);
    const { charge } = await assertChargeConsistent(bill._id);
    assert.equal(charge.status, "PAID");
    assert.ok(Math.abs(charge.paidAmount - 0.3) < 1e-9);
  });
});

describe("payExpense / returnWithdrawal / addExpense", () => {
  let f;
  before(async () => {
    f = await setup({ name: "Expense Tower", tenants: 1 });
    assert.equal((await openMonth(f.bid, "2026-01")).ok, true);
    signInAs(staff.manager);
  });
  const base = () => ({ buildingId: f.bid, monthYear: "2026-01" });

  test("payExpense: normal, overpay rejected, then CONCURRENCY 10 x 150 on 1000", async () => {
    signInAs(staff.manager);
    assert.equal((await L.addExpense(PREV, fd({ ...base(), description: "Pump", amount: "1000", status: "DUE" }))).ok, true);
    const exp = await ctx.Expense.findOne({ buildingId: f.bid, description: "Pump" }).lean();
    assert.equal(exp.status, "DUE");
    assert.equal(exp.paidAmount, 0);
    assert.deepEqual(exp.payments, []);

    const over = await L.payExpense(PREV, fd({ ...base(), id: String(exp._id), amount: "1000.01" }));
    assert.match(over.error, /exceeds the outstanding 1000/);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => L.payExpense(PREV, fd({ ...base(), id: String(exp._id), amount: "150" }))),
    );
    assert.equal(results.filter((r) => r.status === "rejected").length, 0);
    assert.equal(results.filter((r) => r.value.ok).length, 6);
    let after = await ctx.Expense.findById(exp._id).lean();
    assert.equal(after.paidAmount, 900);
    assert.equal(after.payments.length, 6);
    assert.equal(after.payments.reduce((s, p) => s + p.amount, 0), after.paidAmount);
    assert.equal(after.status, "PARTIAL");
    assert.equal(after.paidAt, null);

    assert.equal((await L.payExpense(PREV, fd({ ...base(), id: String(exp._id), amount: "100", date: "2026-01-20" }))).ok, true);
    after = await ctx.Expense.findById(exp._id).lean();
    assert.equal(after.status, "PAID");
    assert.equal(after.paidAt.toISOString(), "2026-01-20T12:00:00.000Z");
    const full = await L.payExpense(PREV, fd({ ...base(), id: String(exp._id), amount: "0.01" }));
    assert.equal(full.error, "This expense is already fully paid.");
  });

  test("returnWithdrawal: normal, overpay rejected, CONCURRENCY 10 x 300 on 1000", async () => {
    signInAs(staff.manager);
    assert.equal((await L.addWithdrawal(PREV, fd({ ...base(), takenBy: "Karim", amount: "1000", note: "" }))).ok, true);
    const wd = await ctx.Withdrawal.findOne({ buildingId: f.bid, takenBy: "Karim" }).lean();
    const over = await L.returnWithdrawal(PREV, fd({ ...base(), id: String(wd._id), amount: "1000.5" }));
    assert.match(over.error, /exceeds the outstanding 1000/);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => L.returnWithdrawal(PREV, fd({ ...base(), id: String(wd._id), amount: "300" }))),
    );
    assert.equal(results.filter((r) => r.ok).length, 3);
    const after = await ctx.Withdrawal.findById(wd._id).lean();
    assert.equal(after.returnedAmount, 900);
    assert.equal(after.returns.length, 3);
    assert.equal(after.returns.reduce((s, r) => s + r.amount, 0), 900);
    assert.ok(after.returnedAmount <= after.amount);
  });

  test("addExpense: forced voucher clash -> retry writes the same payload with the next voucher", async () => {
    signInAs(staff.manager);
    const Expense = ctx.Expense;
    const originalCreate = Expense.create;
    let calls = 0;
    const attempts = [];
    Expense.create = async function (docs, ...rest) {
      // The action passes [doc] (array form, required to pass a session).
      const doc = Array.isArray(docs) ? docs[0] : docs;
      calls += 1;
      attempts.push({ ...doc });
      if (calls === 1) {
        // Another request grabs this voucher number between read and insert.
        await Expense.collection.insertOne({
          buildingId: new ctx.conn.Types.ObjectId(String(doc.buildingId)),
          monthYear: doc.monthYear,
          voucherNo: doc.voucherNo,
          description: "intruder",
          amount: 1,
          paidAmount: 0,
          payments: [],
          status: "DUE",
        });
      }
      return originalCreate.call(this, docs, ...rest);
    };
    try {
      const res = await L.addExpense(
        PREV,
        fd({ ...base(), category: "Repair", description: "Gate weld", amount: "250.5", status: "PAID", date: "2026-01-10" }),
      );
      assert.deepEqual(res, { error: null, ok: true });
    } finally {
      Expense.create = originalCreate;
    }
    assert.equal(calls, 2, "expected exactly one retry after the clash");
    const { voucherNo: v1, ...p1 } = attempts[0];
    const { voucherNo: v2, ...p2 } = attempts[1];
    assert.equal(v2, v1 + 1);
    assert.deepEqual(p2, p1, "retry payload must equal the first attempt");
    const saved = await Expense.findOne({ buildingId: f.bid, description: "Gate weld" }).lean();
    assert.equal(saved.voucherNo, v2);
    assert.equal(saved.category, "Repair");
    assert.equal(saved.amount, 250.5);
    assert.equal(saved.paidAmount, 250.5);
    assert.equal(saved.status, "PAID");
    assert.equal(saved.payments.length, 1);
    assert.equal(saved.payments[0].monthYear, "2026-01");
    assert.equal(saved.paidAt.toISOString(), "2026-01-10T12:00:00.000Z");
  });

  test("addExpense CONCURRENCY: 2 parallel inserts both succeed with distinct vouchers", async () => {
    signInAs(staff.manager);
    const results = await Promise.allSettled(
      [1, 2].map((i) => L.addExpense(PREV, fd({ ...base(), description: `Pair ${i}`, amount: "10", status: "DUE" }))),
    );
    assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled"]);
    const rows = await ctx.Expense.find({ buildingId: f.bid, description: /^Pair / }).lean();
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].voucherNo, rows[1].voucherNo);
  });

  test("addExpense CONCURRENCY: 6 parallel inserts all succeed (single retry may not be enough)", async () => {
    signInAs(staff.manager);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        L.addExpense(PREV, fd({ ...base(), description: `Burst ${i}`, amount: "10", status: "DUE" })),
      ),
    );
    const rows = await ctx.Expense.find({ buildingId: f.bid, description: /^Burst / }).lean();
    const vouchers = rows.map((r) => r.voucherNo);
    assert.equal(new Set(vouchers).size, vouchers.length, "voucher numbers must be unique");
    const thrown = results.filter((r) => r.status === "rejected").map((r) => r.reason?.code ?? String(r.reason));
    assert.deepEqual(thrown, [], `${thrown.length}/6 submissions threw (E11000 after the single retry)`);
  });
});

describe("closed / unopened months refuse writes", () => {
  let f;
  let charge;
  let expense;
  let wd;
  before(async () => {
    f = await setup({ name: "Closed Tower", tenants: 1 });
    await openMonth(f.bid, "2026-01");
    [charge] = await chargesFor(f.bid, "2026-01");
    signInAs(staff.superAdmin);
    await L.addExpense(PREV, fd({ buildingId: f.bid, monthYear: "2026-01", description: "Due bill", amount: "100", status: "DUE" }));
    await L.addWithdrawal(PREV, fd({ buildingId: f.bid, monthYear: "2026-01", takenBy: "Rahim", amount: "100", note: "" }));
    expense = await ctx.Expense.findOne({ buildingId: f.bid }).lean();
    wd = await ctx.Withdrawal.findOne({ buildingId: f.bid }).lean();
    await L.addCharge(
      PREV,
      fd({ buildingId: f.bid, monthYear: "2026-01", tenancyId: String(f.tenants[0].tenancy._id), category: "BILL", description: "Water", amount: "50" }),
    );
    await closeMonth(f.bid, "2026-01");
  });

  test("every write action returns 'That month is closed.' and nothing changes", async () => {
    signInAs(staff.superAdmin);
    const before = {
      payments: await ctx.Payment.countDocuments({ buildingId: f.bid }),
      incomes: await ctx.Income.countDocuments({ buildingId: f.bid }),
      expenses: await ctx.Expense.countDocuments({ buildingId: f.bid }),
      withdrawals: await ctx.Withdrawal.countDocuments({ buildingId: f.bid }),
      charges: await ctx.Charge.countDocuments({ buildingId: f.bid }),
    };
    const m = { buildingId: f.bid, monthYear: "2026-01" };
    const water = await ctx.Charge.findOne({ buildingId: f.bid, description: "Water" }).lean();
    const results = {
      recordPayment: await L.recordPayment(PREV, fd({ ...m, chargeId: String(charge._id), amount: "1" })),
      addIncome: await L.addIncome(PREV, fd({ ...m, source: "OTHER", description: "x", amount: "1" })),
      addExpense: await L.addExpense(PREV, fd({ ...m, description: "x", amount: "1", status: "PAID" })),
      addWithdrawal: await L.addWithdrawal(PREV, fd({ ...m, takenBy: "x", amount: "1", note: "" })),
      payExpense: await L.payExpense(PREV, fd({ ...m, id: String(expense._id), amount: "1" })),
      returnWithdrawal: await L.returnWithdrawal(PREV, fd({ ...m, id: String(wd._id), amount: "1" })),
      addCharge: await L.addCharge(PREV, fd({ ...m, tenancyId: String(f.tenants[0].tenancy._id), category: "BILL", description: "x", amount: "1" })),
      editCharge: await L.editCharge(PREV, fd({ ...m, chargeId: String(water._id), description: "Water", amount: "60" })),
      updateMonthNote: await L.updateMonthNote(PREV, fd({ ...m, note: "x" })),
      adjustOpeningBalance: await L.adjustOpeningBalance(PREV, fd({ ...m, openingBalance: "5" })),
    };
    for (const [name, r] of Object.entries(results)) {
      assert.equal(r.error, "That month is closed.", name);
    }
    // Form-only actions return undefined; verify by state.
    await L.removeCharge(fd({ ...m, chargeId: String(water._id) }));
    await L.deleteExpense(fd({ ...m, id: String(expense._id) }));
    await L.deleteWithdrawal(fd({ ...m, id: String(wd._id) }));
    const after = {
      payments: await ctx.Payment.countDocuments({ buildingId: f.bid }),
      incomes: await ctx.Income.countDocuments({ buildingId: f.bid }),
      expenses: await ctx.Expense.countDocuments({ buildingId: f.bid }),
      withdrawals: await ctx.Withdrawal.countDocuments({ buildingId: f.bid }),
      charges: await ctx.Charge.countDocuments({ buildingId: f.bid }),
    };
    assert.deepEqual(after, before);
    assert.equal((await ctx.Charge.findById(water._id).lean()).amount, 50);
  });

  test("a month that was never opened returns 'That month is not open.'", async () => {
    signInAs(staff.superAdmin);
    const r = await L.addIncome(PREV, fd({ buildingId: f.bid, monthYear: "2026-06", source: "OTHER", description: "x", amount: "1" }));
    assert.equal(r.error, "That month is not open.");
  });
});

describe("close / reopen / open: opening-balance chain", () => {
  let f;
  before(async () => {
    f = await setup({ name: "Chain Tower", tenants: 2 });
  });
  const m = (monthYear) => ({ buildingId: f.bid, monthYear });

  test("closing = opening + payments + income - expenses paid - withdrawals + returns; chain cascades", async () => {
    assert.equal((await openMonth(f.bid, "2026-01", { openingBalance: 500 })).ok, true);
    const [c0, c1] = await chargesFor(f.bid, "2026-01");
    signInAs(staff.superAdmin);
    assert.equal((await L.recordPayment(PREV, fd({ ...m("2026-01"), chargeId: String(c0._id), amount: "1000" }))).ok, true);
    assert.equal((await L.recordPayment(PREV, fd({ ...m("2026-01"), chargeId: String(c1._id), amount: "250.25" }))).ok, true);
    assert.equal((await L.addIncome(PREV, fd({ ...m("2026-01"), source: "ROOFTOP_RENT", description: "Roof", amount: "300" }))).ok, true);
    assert.equal((await L.addExpense(PREV, fd({ ...m("2026-01"), description: "Paid bill", amount: "120.1", status: "PAID" }))).ok, true);
    assert.equal((await L.addExpense(PREV, fd({ ...m("2026-01"), description: "Due bill", amount: "200", status: "DUE" }))).ok, true);
    assert.equal((await L.addWithdrawal(PREV, fd({ ...m("2026-01"), takenBy: "Owner", amount: "400", note: "" }))).ok, true);
    const wd = await ctx.Withdrawal.findOne({ buildingId: f.bid }).lean();
    assert.equal((await L.returnWithdrawal(PREV, fd({ ...m("2026-01"), id: String(wd._id), amount: "150" }))).ok, true);

    await closeMonth(f.bid, "2026-01");
    const jan = await ctx.MonthlyPeriod.findOne(m("2026-01")).lean();
    const expectedJan = 500 + 1250.25 + 300 - 120.1 - 400 + 150;
    assert.equal(jan.status, "CLOSED");
    assert.ok(Math.abs(jan.closingBalance - expectedJan) < 1e-6, `${jan.closingBalance} vs ${expectedJan}`);
    // Unpaid service charge and DUE expense tagged as carried forward.
    assert.equal((await ctx.Charge.findById(c1._id).lean()).carriedFrom, "2026-01");
    assert.equal((await ctx.Charge.findById(c0._id).lean()).carriedFrom, null);
    assert.equal((await ctx.Expense.findOne({ buildingId: f.bid, description: "Due bill" }).lean()).carriedFrom, "2026-01");

    // Manual opening is ignored when the previous month is closed.
    assert.equal((await openMonth(f.bid, "2026-02", { openingBalance: 99999 })).ok, true);
    let feb = await ctx.MonthlyPeriod.findOne(m("2026-02")).lean();
    assert.ok(Math.abs(feb.openingBalance - expectedJan) < 1e-6);

    // Feb: pay Jan's carried-forward due (cash arrives in Feb), pay Jan's DUE expense.
    assert.equal((await L.recordPayment(PREV, fd({ ...m("2026-02"), chargeId: String(c1._id), amount: "100" }))).ok, true);
    const dueBill = await ctx.Expense.findOne({ buildingId: f.bid, description: "Due bill" }).lean();
    assert.equal((await L.payExpense(PREV, fd({ ...m("2026-02"), id: String(dueBill._id), amount: "200" }))).ok, true);
    await closeMonth(f.bid, "2026-02");
    feb = await ctx.MonthlyPeriod.findOne(m("2026-02")).lean();
    const febPayments = 2 * 0 + 100; // Feb's own service charges are unpaid
    const expectedFeb = expectedJan + febPayments - 200;
    assert.ok(Math.abs(feb.closingBalance - expectedFeb) < 1e-6, `${feb.closingBalance} vs ${expectedFeb}`);
    // Jan's closing is NOT altered by Feb's activity.
    assert.ok(Math.abs((await ctx.MonthlyPeriod.findOne(m("2026-01")).lean()).closingBalance - expectedJan) < 1e-6);

    // Reopen Jan, add income, close again: Feb opening and closing cascade.
    await reopenMonth(f.bid, "2026-01");
    assert.equal((await ctx.MonthlyPeriod.findOne(m("2026-01")).lean()).status, "OPEN");
    assert.equal((await L.addIncome(PREV, fd({ ...m("2026-01"), source: "CHARITY", description: "Late", amount: "50" }))).ok, true);
    // reopen of another month is refused while Jan is open
    await reopenMonth(f.bid, "2026-02");
    assert.equal((await ctx.MonthlyPeriod.findOne(m("2026-02")).lean()).status, "CLOSED");
    await closeMonth(f.bid, "2026-01");
    const jan2 = await ctx.MonthlyPeriod.findOne(m("2026-01")).lean();
    const feb2 = await ctx.MonthlyPeriod.findOne(m("2026-02")).lean();
    assert.ok(Math.abs(jan2.closingBalance - (expectedJan + 50)) < 1e-6);
    assert.ok(Math.abs(feb2.openingBalance - (expectedJan + 50)) < 1e-6);
    assert.ok(Math.abs(feb2.closingBalance - (expectedFeb + 50)) < 1e-6);

    assert.equal((await openMonth(f.bid, "2026-03")).ok, true);
    const mar = await ctx.MonthlyPeriod.findOne(m("2026-03")).lean();
    assert.ok(Math.abs(mar.openingBalance - (expectedFeb + 50)) < 1e-6);

    // Cross-check with the library's own computation for every closed month.
    for (const p of [jan2, feb2]) {
      const totals = await getPeriodTotals(f.bid, p.monthYear);
      assert.ok(Math.abs(computeClosing(p.openingBalance, totals) - p.closingBalance) < 1e-6);
    }
  });

  test("closeMonth / reopenMonth are refused for a MANAGER", async () => {
    signInAs(staff.manager);
    await assert.rejects(L.closeMonth(fd(m("2026-03"))), /FORBIDDEN/);
    await assert.rejects(L.reopenMonth(fd(m("2026-02"))), /FORBIDDEN/);
    assert.equal((await ctx.MonthlyPeriod.findOne(m("2026-03")).lean()).status, "OPEN");
  });

  test("CONCURRENCY: payments racing closeMonth never leave the stored closing balance stale", async () => {
    const g = await setup({ name: "Close Race Tower", tenants: 3 });
    const mismatches = [];
    const months = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05"];
    for (const monthYear of months) {
      assert.equal((await openMonth(g.bid, monthYear)).ok, true);
      const charges = await chargesFor(g.bid, monthYear);
      signInAs(staff.superAdmin);
      const pays = charges.flatMap((c) =>
        Array.from({ length: 4 }, () =>
          L.recordPayment(PREV, fd({ buildingId: g.bid, monthYear, chargeId: String(c._id), amount: "10" })),
        ),
      );
      await Promise.allSettled([...pays, L.closeMonth(fd({ buildingId: g.bid, monthYear }))]);
      const p = await ctx.MonthlyPeriod.findOne({ buildingId: g.bid, monthYear }).lean();
      if (p.status !== "CLOSED") await closeMonth(g.bid, monthYear);
      const fresh = await ctx.MonthlyPeriod.findOne({ buildingId: g.bid, monthYear }).lean();
      const totals = await getPeriodTotals(g.bid, monthYear);
      const truth = computeClosing(fresh.openingBalance, totals);
      if (Math.abs(truth - fresh.closingBalance) > 1e-6) {
        mismatches.push(`${monthYear}: stored ${fresh.closingBalance}, ledger says ${truth}`);
      }
    }
    assert.deepEqual(mismatches, [], "payments landed in a month after its closing balance was computed");
  });
});

describe("deleteMonth", () => {
  let f;
  const m = (monthYear) => ({ buildingId: f.bid, monthYear });
  const del = (monthYear) => L.deleteMonth(PREV, fd(m(monthYear)));

  before(async () => {
    f = await setup({ name: "Delete Tower", tenants: 2 });
    await openMonth(f.bid, "2026-01", { openingBalance: 100 });
    await closeMonth(f.bid, "2026-01");
    await openMonth(f.bid, "2026-02");
  });

  test("MANAGER is refused (and nothing is deleted)", async () => {
    signInAs(staff.manager);
    let result;
    let thrown = null;
    try {
      result = await del("2026-02");
    } catch (err) {
      thrown = err;
    }
    assert.ok(await ctx.MonthlyPeriod.exists(m("2026-02")));
    assert.equal(await ctx.Charge.countDocuments(m("2026-02")), 2);
    // Contract of ConfirmActionForm: refusals come back as {error}.
    assert.equal(thrown, null, `deleteMonth threw ${thrown?.message} instead of returning {error}`);
    assert.equal(result.ok, false);
  });

  test("refused when a later month exists, with a message", async () => {
    signInAs(staff.superAdmin);
    const res = await del("2026-01");
    assert.equal(res.ok, false);
    assert.match(res.error, /Only the latest month can be deleted/);
    assert.ok(await ctx.MonthlyPeriod.exists(m("2026-01")));
  });

  test("refused when another month allocated a payment to this month's charges", async () => {
    signInAs(staff.superAdmin);
    const [febCharge] = await chargesFor(f.bid, "2026-02");
    await closeMonth(f.bid, "2026-02");
    await reopenMonth(f.bid, "2026-01");
    // Booked in January, settling a February due (an advance payment).
    assert.equal((await L.recordPayment(PREV, fd({ ...m("2026-01"), chargeId: String(febCharge._id), amount: "300" }))).ok, true);
    await closeMonth(f.bid, "2026-01");
    const res = await del("2026-02");
    assert.equal(res.ok, false);
    assert.match(res.error, /payment booked in another month settles a due from this month/);
    assert.equal(await ctx.Charge.countDocuments(m("2026-02")), 2);

    // Undo it (reopen Jan, reverse, close) so the next test can delete Feb.
    await reopenMonth(f.bid, "2026-01");
    const pay = await ctx.Payment.findOne({ buildingId: f.bid, monthYear: "2026-01" }).lean();
    await L.reversePayment(fd({ ...m("2026-01"), id: String(pay._id) }));
    assert.equal(await ctx.Payment.countDocuments({ buildingId: f.bid }), 0);
    assert.equal((await ctx.Charge.findById(febCharge._id).lean()).paidAmount, 0);
    await closeMonth(f.bid, "2026-01");
  });

  test("refused when an earlier expense was paid during this month", async () => {
    signInAs(staff.superAdmin);
    await reopenMonth(f.bid, "2026-01");
    await L.addExpense(PREV, fd({ ...m("2026-01"), description: "Old bill", amount: "40", status: "DUE" }));
    await closeMonth(f.bid, "2026-01");
    await reopenMonth(f.bid, "2026-02");
    const bill = await ctx.Expense.findOne({ buildingId: f.bid, description: "Old bill" }).lean();
    assert.equal((await L.payExpense(PREV, fd({ ...m("2026-02"), id: String(bill._id), amount: "40" }))).ok, true);
    const res = await del("2026-02");
    assert.match(res.error, /earlier expense was paid during this month/);
    // Undo the payment.
    await L.reverseExpensePayment(fd({ ...m("2026-02"), id: String(bill._id) }));
    assert.equal((await ctx.Expense.findById(bill._id).lean()).paidAmount, 0);
  });

  test("succeeds for the latest month with no dependents; earlier charges restored; chain intact", async () => {
    signInAs(staff.superAdmin);
    const [janCharge] = await chargesFor(f.bid, "2026-01");
    // Feb (open) receives a payment toward a JANUARY due and its own stuff.
    assert.equal((await L.recordPayment(PREV, fd({ ...m("2026-02"), chargeId: String(janCharge._id), amount: "200" }))).ok, true);
    await L.addIncome(PREV, fd({ ...m("2026-02"), source: "OTHER", description: "x", amount: "5" }));
    assert.equal((await ctx.Charge.findById(janCharge._id).lean()).paidAmount, 200);
    const res = await del("2026-02");
    assert.deepEqual(res, { error: null, ok: true });
    assert.equal(await ctx.MonthlyPeriod.exists(m("2026-02")), null);
    for (const Model of [ctx.Charge, ctx.Payment, ctx.Income, ctx.Expense, ctx.Withdrawal]) {
      assert.equal(await Model.countDocuments(m("2026-02")), 0, Model.modelName);
    }
    const restored = await ctx.Charge.findById(janCharge._id).lean();
    assert.equal(restored.paidAmount, 0);
    assert.equal(restored.status, "DUE");
    assert.ok(await ctx.MonthlyPeriod.exists(m("2026-01")));
    assert.ok(await ctx.AuditLog.exists({ entity: "MonthlyPeriod", action: "DELETE", buildingId: f.bid }));
  });

  test("deleting a month that no longer exists returns an {error}", async () => {
    signInAs(staff.superAdmin);
    const res = await del("2026-02");
    assert.equal(res.error, "This month no longer exists.");
  });
});

describe("validators (money)", () => {
  const V = load("src/lib/validators/ledger.ts");
  const T = load("src/lib/validators/tenant.ts");
  const oid = "0123456789abcdef01234567";
  const parse = (schema, amount) =>
    schema.safeParse({ buildingId: oid, monthYear: "2026-01", chargeId: oid, amount });

  test("rounds to 2 decimals, caps at 1e9, rejects 0.004, 0, negatives, junk", () => {
    assert.equal(parse(V.payChargeSchema, "10.005").data?.amount, round2(10.005));
    assert.equal(parse(V.payChargeSchema, "10.126").data.amount, 10.13);
    assert.equal(parse(V.payChargeSchema, "0.005").data.amount, 0.01);
    assert.equal(parse(V.payChargeSchema, "1000000000").data.amount, 1e9);
    for (const bad of ["1000000000.01", "0.004", "0", "-1", "abc", "", "Infinity", "NaN", "1e10"]) {
      assert.equal(parse(V.payChargeSchema, bad).success, false, `accepted ${JSON.stringify(bad)}`);
    }
    assert.match(parse(V.payChargeSchema, "0.004").error.issues[0].message, /at least 0.01/);
    assert.match(parse(V.payChargeSchema, "1000000001").error.issues[0].message, /too large/);
    const manual = T.manualChargeSchema.safeParse({
      buildingId: oid, userId: oid, category: "BILL", monthYear: "2026-01", description: "d", amount: "0.004",
    });
    assert.equal(manual.success, false);
    const manualOk = T.manualChargeSchema.safeParse({
      buildingId: oid, userId: oid, category: "BILL", monthYear: "2026-01", description: "d", amount: "12.345",
    });
    assert.equal(manualOk.data.amount, 12.35);
  });

  test("end to end: an action stores the rounded amount", async () => {
    const g = await setup({ name: "Round Tower", tenants: 1 });
    await openMonth(g.bid, "2026-01");
    signInAs(staff.superAdmin);
    assert.equal((await L.addIncome(PREV, fd({ buildingId: g.bid, monthYear: "2026-01", source: "OTHER", description: "r", amount: "33.337" }))).ok, true);
    assert.equal((await ctx.Income.findOne({ buildingId: g.bid }).lean()).amount, 33.34);
    const r = await L.addIncome(PREV, fd({ buildingId: g.bid, monthYear: "2026-01", source: "OTHER", description: "r", amount: "0.004" }));
    assert.equal(r.error, "Amount must be at least 0.01.");
  });

  test("openMonth money fields (serviceChargeAmount / openingBalance) are rounded too", () => {
    const r = V.openMonthSchema.safeParse({ buildingId: oid, monthYear: "2026-01", serviceChargeAmount: "100.555", openingBalance: "0.004" });
    assert.equal(r.success, true);
    assert.equal(r.data.serviceChargeAmount, 100.56, "service charge not rounded to 2 decimals");
    assert.equal(r.data.openingBalance, 0, "opening balance not rounded to 2 decimals");
  });

  test("end to end: a month opened with a 3-decimal service charge can still be fully paid", async () => {
    const g = await setup({ name: "Sub-paisa Tower", tenants: 1 });
    assert.equal((await openMonth(g.bid, "2026-01", { serviceChargeAmount: "100.555" })).ok, true);
    const [c] = await chargesFor(g.bid, "2026-01");
    signInAs(staff.superAdmin);
    const pay = (amount) => L.recordPayment(PREV, fd({ buildingId: g.bid, monthYear: "2026-01", chargeId: String(c._id), amount }));
    const first = await pay("100.55");
    const second = await pay("0.01");
    const after = await ctx.Charge.findById(c._id).lean();
    assert.equal(after.status, "PAID", `stored amount ${after.amount}, paid ${after.paidAmount}; second payment: ${JSON.stringify(second)} first: ${JSON.stringify(first)}`);
  });
});

/**
 * Deterministically reproduce a request interleaving: the NEXT call to
 * `Model[method]` resolves its result, then runs `between()` (another
 * request completing in full), then hands the stale result to the caller.
 */
function interleaveOnce(Model, method, between) {
  const original = Model[method];
  Model[method] = function (...args) {
    Model[method] = original;
    const query = original.apply(this, args);
    return {
      then(resolve, reject) {
        return query.then(async (doc) => {
          await between();
          return doc;
        }).then(resolve, reject);
      },
    };
  };
  return () => {
    Model[method] = original;
  };
}

describe("lost updates: read-modify-save actions interleaved with other requests", () => {
  let f;
  const m = () => ({ buildingId: f.bid, monthYear: "2026-01" });
  before(async () => {
    f = await setup({ name: "Lost Update Tower", tenants: 3 });
    assert.equal((await openMonth(f.bid, "2026-01")).ok, true);
  });
  const newBill = async (description, amount = "1000") => {
    signInAs(staff.superAdmin);
    assert.equal(
      (await L.addCharge(PREV, fd({ ...m(), tenancyId: String(f.tenants[0].tenancy._id), category: "BILL", description, amount }))).ok,
      true,
    );
    return ctx.Charge.findOne({ buildingId: f.bid, description }).lean();
  };
  const pay = (chargeId, amount) => L.recordPayment(PREV, fd({ ...m(), chargeId: String(chargeId), amount }));

  test("reversePayment: a payment recorded between its read and save is not wiped out", async () => {
    signInAs(staff.superAdmin);
    const bill = await newBill("Rev interleave");
    assert.equal((await pay(bill._id, "100")).ok, true);
    const p = await ctx.Payment.findOne({ "allocations.chargeId": bill._id }).lean();
    let concurrentPayDone = false;
    const concurrentPay = async () => {
      concurrentPayDone = true;
      assert.equal((await pay(bill._id, "300")).ok, true);
    };
    const restore = interleaveOnce(ctx.Charge, "findById", concurrentPay);
    try {
      await L.reversePayment(fd({ ...m(), id: String(p._id) }));
    } finally {
      restore();
    }
    // An implementation that never reads the charge (atomic decrement) has no
    // read-save window to hook; the other payment must still land and survive.
    if (!concurrentPayDone) await concurrentPay();
    const { charge } = await (async () => {
      const c = await ctx.Charge.findById(bill._id).lean();
      return { charge: c };
    })();
    const pays = await ctx.Payment.find({ "allocations.chargeId": bill._id }).lean();
    const alloc = pays.reduce((s, x) => s + x.allocations[0].amount, 0);
    assert.equal(alloc, 300);
    assert.equal(charge.paidAmount, 300, `paidAmount ${charge.paidAmount} but allocations ${alloc}`);
  });

  test("reversePayment submitted twice (double click) reverses the charge only once", async () => {
    signInAs(staff.superAdmin);
    const bill = await newBill("Double reverse");
    assert.equal((await pay(bill._id, "100")).ok, true);
    assert.equal((await pay(bill._id, "200")).ok, true);
    const p = await ctx.Payment.findOne({ "allocations.chargeId": bill._id, totalAmount: 100 }).lean();
    const form = () => fd({ ...m(), id: String(p._id) });
    // Request 1 reads the payment; request 2 runs completely; request 1 continues.
    const restore = interleaveOnce(ctx.Payment, "findOne", () => L.reversePayment(form()));
    try {
      await L.reversePayment(form());
    } finally {
      restore();
    }
    const c = await ctx.Charge.findById(bill._id).lean();
    assert.equal(await ctx.Payment.countDocuments({ "allocations.chargeId": bill._id }), 1);
    assert.equal(c.paidAmount, 200, `paidAmount ${c.paidAmount} after reversing the 100 payment once`);
  });

  test("editCharge: a payment between its read and save cannot leave amount < paidAmount / stale status", async () => {
    signInAs(staff.superAdmin);
    const bill = await newBill("Edit interleave");
    const restore = interleaveOnce(ctx.Charge, "findOne", async () => {
      assert.equal((await pay(bill._id, "600")).ok, true);
    });
    let res;
    try {
      res = await L.editCharge(PREV, fd({ ...m(), chargeId: String(bill._id), description: "Edit interleave", amount: "250" }));
    } finally {
      restore();
    }
    const c = await ctx.Charge.findById(bill._id).lean();
    assert.ok(
      c.paidAmount <= c.amount + 1e-6 && c.status === (c.paidAmount + 1e-6 >= c.amount ? "PAID" : "PARTIAL"),
      `edit returned ${JSON.stringify(res)}; charge now amount ${c.amount}, paid ${c.paidAmount}, status ${c.status}`,
    );
  });

  test("reverseExpensePayment: a payExpense between its read and save keeps the log and total in sync", async () => {
    signInAs(staff.superAdmin);
    assert.equal((await L.addExpense(PREV, fd({ ...m(), description: "Exp interleave", amount: "1000", status: "DUE" }))).ok, true);
    const e = await ctx.Expense.findOne({ buildingId: f.bid, description: "Exp interleave" }).lean();
    assert.equal((await L.payExpense(PREV, fd({ ...m(), id: String(e._id), amount: "100" }))).ok, true);
    const restore = interleaveOnce(ctx.Expense, "findOne", async () => {
      assert.equal((await L.payExpense(PREV, fd({ ...m(), id: String(e._id), amount: "250" }))).ok, true);
    });
    try {
      await L.reverseExpensePayment(fd({ ...m(), id: String(e._id) }));
    } finally {
      restore();
    }
    const after = await ctx.Expense.findById(e._id).lean();
    const sum = after.payments.reduce((s, p) => s + p.amount, 0);
    assert.equal(sum, after.paidAmount, `paidAmount ${after.paidAmount} vs log ${JSON.stringify(after.payments.map((p) => p.amount))}`);
    assert.equal(after.paidAmount, 250, "the 250 payment recorded meanwhile must survive; only one entry is undone");
  });

  test("reverseWithdrawalReturn: a return between its read and save keeps the log and total in sync", async () => {
    signInAs(staff.superAdmin);
    assert.equal((await L.addWithdrawal(PREV, fd({ ...m(), takenBy: "Interleaver", amount: "1000", note: "" }))).ok, true);
    const w = await ctx.Withdrawal.findOne({ buildingId: f.bid, takenBy: "Interleaver" }).lean();
    assert.equal((await L.returnWithdrawal(PREV, fd({ ...m(), id: String(w._id), amount: "100" }))).ok, true);
    const restore = interleaveOnce(ctx.Withdrawal, "findOne", async () => {
      assert.equal((await L.returnWithdrawal(PREV, fd({ ...m(), id: String(w._id), amount: "250" }))).ok, true);
    });
    try {
      await L.reverseWithdrawalReturn(fd({ ...m(), id: String(w._id) }));
    } finally {
      restore();
    }
    const after = await ctx.Withdrawal.findById(w._id).lean();
    const sum = after.returns.reduce((s, r) => s + r.amount, 0);
    assert.equal(sum, after.returnedAmount, `returnedAmount ${after.returnedAmount} vs log ${JSON.stringify(after.returns.map((r) => r.amount))}`);
    assert.equal(after.returnedAmount, 250);
  });
});
