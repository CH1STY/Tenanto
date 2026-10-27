// Data integrity report. STRICTLY READ-ONLY.
//
// Run with:  npm run check:data
//   (= node --env-file=.env.local scripts/check-data.mjs)
//
// What it does: connects to MONGODB_URI, reads the ledger collections with
// find / countDocuments / aggregate / distinct only, and prints a plain-text
// report of orphaned references, missing months, paid-amount drift, status
// mismatches and the opening-balance chain. It never modifies anything:
//   - the connection uses readPreference "secondaryPreferred" and autoIndex /
//     autoCreate are off (and no Mongoose models are registered, so nothing
//     can build indexes or collections);
//   - every collection (and the db handle itself) is wrapped in a Proxy that
//     throws on any method whose name looks like a write (insert, update,
//     delete, replace, drop, create, bulk, rename, findOneAnd*);
//   - aggregate pipelines are refused if they contain $out or $merge.
// Prints the target host only (never credentials). Exits 0 when the report
// completes, 1 if it cannot connect or a guard trips.
import mongoose from "mongoose";

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

const { MONGODB_URI } = process.env;
if (!MONGODB_URI) {
  console.error("MONGODB_URI is not set. Refusing to start.");
  process.exit(1);
}

const WRITE_METHOD = /insert|update|delete|replace|drop|create|bulk|rename|findOneAnd/i;

function readOnly(target, label) {
  return new Proxy(target, {
    get(obj, prop) {
      if (typeof prop === "string" && WRITE_METHOD.test(prop)) {
        throw new Error(`READ-ONLY GUARD: ${label}.${prop}() is not allowed.`);
      }
      const value = Reflect.get(obj, prop);
      if (prop === "aggregate" && typeof value === "function") {
        return (pipeline = [], ...rest) => {
          const stages = JSON.stringify(pipeline);
          if (/"\$(out|merge)"/.test(stages)) {
            throw new Error(`READ-ONLY GUARD: $out/$merge in ${label}.aggregate.`);
          }
          return value.call(obj, pipeline, ...rest);
        };
      }
      return typeof value === "function" ? value.bind(obj) : value;
    },
  });
}

/** Host part of a Mongo URI, without user:password, path or query. */
function describeHost(uri) {
  const noScheme = uri.replace(/^[a-z+]+:\/\//i, "");
  const afterCreds = noScheme.slice(noScheme.lastIndexOf("@") + 1);
  const host = afterCreds.split(/[/?]/)[0];
  const dbMatch = afterCreds.match(/^[^/]*\/([^?]+)/);
  return { host, db: dbMatch ? dbMatch[1] : "(default)" };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOL = 0.005;
const id = (v) => (v == null ? "null" : String(v));
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const money = (v) => num(v).toFixed(2);
const near = (a, b) => Math.abs(num(a) - num(b)) <= TOL;

const summary = [];
let buildingName = new Map();
const bName = (bid) => buildingName.get(id(bid)) ?? `<missing building ${id(bid)}>`;

function section(title, rows, { informational = false } = {}) {
  const tag = informational ? " [informational]" : "";
  console.log(`\n=== ${title}${tag} — ${rows.length} found`);
  const shown = rows.slice(0, 200);
  for (const r of shown) console.log(`  - ${r}`);
  if (rows.length > shown.length) {
    console.log(`  ... and ${rows.length - shown.length} more`);
  }
  summary.push({ title, count: rows.length, informational });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { host, db: dbName } = describeHost(MONGODB_URI);
  console.log("Data integrity report (READ-ONLY)");
  console.log(`Target host: ${host}  database: ${dbName}`);
  console.log(`Run at: ${new Date().toISOString()}`);

  await mongoose.connect(MONGODB_URI, {
    readPreference: "secondaryPreferred",
    autoIndex: false,
    autoCreate: false,
  });
  const db = readOnly(mongoose.connection.db, "db");
  const col = (name) => readOnly(db.collection(name), name);

  const C = {
    buildings: col("buildings"),
    units: col("units"),
    tenancies: col("tenancies"),
    periods: col("monthlyperiods"),
    charges: col("charges"),
    payments: col("payments"),
    expenses: col("expenses"),
    withdrawals: col("withdrawals"),
    media: col("monthmedias"),
  };

  // Load with projections only (MonthMedia.data is never read).
  const [
    buildings,
    unitIds,
    tenancies,
    periods,
    charges,
    payments,
    expenses,
    withdrawals,
    media,
  ] = await Promise.all([
    C.buildings.find({}, { projection: { name: 1 } }).toArray(),
    C.units.distinct("_id"),
    C.tenancies
      .find({}, { projection: { buildingId: 1, unitId: 1 } })
      .toArray(),
    C.periods
      .find(
        {},
        {
          projection: {
            buildingId: 1,
            monthYear: 1,
            status: 1,
            openingBalance: 1,
            closingBalance: 1,
          },
        },
      )
      .toArray(),
    C.charges
      .find(
        {},
        {
          projection: {
            buildingId: 1,
            tenancyId: 1,
            monthYear: 1,
            category: 1,
            amount: 1,
            paidAmount: 1,
            status: 1,
          },
        },
      )
      .toArray(),
    C.payments
      .find(
        {},
        {
          projection: {
            buildingId: 1,
            tenancyId: 1,
            monthYear: 1,
            totalAmount: 1,
            allocations: 1,
          },
        },
      )
      .toArray(),
    C.expenses
      .find(
        {},
        {
          projection: {
            buildingId: 1,
            monthYear: 1,
            voucherNo: 1,
            amount: 1,
            paidAmount: 1,
            payments: 1,
            status: 1,
          },
        },
      )
      .toArray(),
    C.withdrawals
      .find(
        {},
        {
          projection: {
            buildingId: 1,
            monthYear: 1,
            takenBy: 1,
            amount: 1,
            returnedAmount: 1,
            returns: 1,
          },
        },
      )
      .toArray(),
    C.media
      .find({}, { projection: { buildingId: 1, monthYear: 1, periodId: 1 } })
      .toArray(),
  ]);

  console.log(
    `Loaded: ${buildings.length} buildings, ${unitIds.length} units, ` +
      `${tenancies.length} tenancies, ${periods.length} periods, ` +
      `${charges.length} charges, ${payments.length} payments, ` +
      `${expenses.length} expenses, ${withdrawals.length} withdrawals, ` +
      `${media.length} month media`,
  );

  buildingName = new Map(buildings.map((b) => [id(b._id), b.name ?? "(unnamed)"]));
  const buildingSet = new Set(buildingName.keys());
  const unitSet = new Set(unitIds.map(id));
  const tenancySet = new Set(tenancies.map((t) => id(t._id)));
  const chargeById = new Map(charges.map((c) => [id(c._id), c]));
  const periodKey = (bid, my) => `${id(bid)}|${my}`;
  const periodSet = new Set(periods.map((p) => periodKey(p.buildingId, p.monthYear)));
  const periodIdSet = new Set(periods.map((p) => id(p._id)));
  const where = (doc) => `building "${bName(doc.buildingId)}" month ${doc.monthYear ?? "?"}`;

  // 1. Payment allocations pointing at missing charges ----------------------
  const danglingAlloc = [];
  for (const p of payments) {
    for (const a of p.allocations ?? []) {
      if (!chargeById.has(id(a.chargeId))) {
        danglingAlloc.push(
          `Payment ${id(p._id)} (${where(p)}) -> missing Charge ${id(a.chargeId)} ` +
            `[${a.category ?? "?"}] amount ${money(a.amount)}`,
        );
      }
    }
  }
  section("1. Payment allocations referencing non-existent charges", danglingAlloc);

  // 2. Orphan references ----------------------------------------------------
  const orphanRefs = [];
  for (const c of charges) {
    if (!tenancySet.has(id(c.tenancyId))) {
      orphanRefs.push(`Charge ${id(c._id)} (${where(c)}) -> missing Tenancy ${id(c.tenancyId)}`);
    }
  }
  for (const p of payments) {
    if (!tenancySet.has(id(p.tenancyId))) {
      orphanRefs.push(`Payment ${id(p._id)} (${where(p)}) -> missing Tenancy ${id(p.tenancyId)}`);
    }
  }
  for (const t of tenancies) {
    if (!unitSet.has(id(t.unitId))) {
      orphanRefs.push(
        `Tenancy ${id(t._id)} (building "${bName(t.buildingId)}") -> missing Unit ${id(t.unitId)}`,
      );
    }
  }
  section("2a. Charges/Payments with missing Tenancy, Tenancies with missing Unit", orphanRefs);

  const orphanBuilding = [];
  const byBuilding = [
    ["Tenancy", tenancies],
    ["Charge", charges],
    ["Payment", payments],
    ["Expense", expenses],
    ["Withdrawal", withdrawals],
    ["MonthMedia", media],
    ["MonthlyPeriod", periods],
  ];
  for (const [label, rows] of byBuilding) {
    for (const r of rows) {
      if (!buildingSet.has(id(r.buildingId))) {
        orphanBuilding.push(
          `${label} ${id(r._id)} month ${r.monthYear ?? "-"} -> missing Building ${id(r.buildingId)}`,
        );
      }
    }
  }
  section("2b. Documents whose buildingId has no Building", orphanBuilding);

  // 3. Expense.payments[] / Withdrawal.returns[] months without a period -----
  const logNoPeriod = [];
  for (const e of expenses) {
    (e.payments ?? []).forEach((entry, i) => {
      if (!periodSet.has(periodKey(e.buildingId, entry.monthYear))) {
        logNoPeriod.push(
          `Expense ${id(e._id)} (voucher ${e.voucherNo ?? "?"}, ${where(e)}) ` +
            `payments[${i}] month ${entry.monthYear} amount ${money(entry.amount)} has no MonthlyPeriod`,
        );
      }
    });
  }
  for (const w of withdrawals) {
    (w.returns ?? []).forEach((entry, i) => {
      if (!periodSet.has(periodKey(w.buildingId, entry.monthYear))) {
        logNoPeriod.push(
          `Withdrawal ${id(w._id)} (${w.takenBy ?? "?"}, ${where(w)}) ` +
            `returns[${i}] month ${entry.monthYear} amount ${money(entry.amount)} has no MonthlyPeriod`,
        );
      }
    });
  }
  section("3. Expense payment / withdrawal return entries in months with no MonthlyPeriod", logNoPeriod);

  // 4. Charges / Payments in months without a period ------------------------
  const txNoPeriod = [];
  for (const c of charges) {
    if (!periodSet.has(periodKey(c.buildingId, c.monthYear))) {
      txNoPeriod.push(`Charge ${id(c._id)} [${c.category}] (${where(c)}) has no MonthlyPeriod`);
    }
  }
  for (const p of payments) {
    if (!periodSet.has(periodKey(p.buildingId, p.monthYear))) {
      txNoPeriod.push(
        `Payment ${id(p._id)} total ${money(p.totalAmount)} (${where(p)}) has no MonthlyPeriod`,
      );
    }
  }
  section("4. Charges / Payments whose monthYear has no MonthlyPeriod", txNoPeriod);

  // 5. MonthMedia without a period ------------------------------------------
  const mediaNoPeriod = [];
  for (const m of media) {
    const missingKey = !periodSet.has(periodKey(m.buildingId, m.monthYear));
    const missingId = m.periodId != null && !periodIdSet.has(id(m.periodId));
    if (missingKey || missingId) {
      const why = [
        missingKey ? "no MonthlyPeriod for (buildingId, monthYear)" : null,
        missingId ? `periodId ${id(m.periodId)} not found` : null,
      ]
        .filter(Boolean)
        .join("; ");
      mediaNoPeriod.push(`MonthMedia ${id(m._id)} (${where(m)}): ${why}`);
    }
  }
  section("5. MonthMedia with no matching MonthlyPeriod", mediaNoPeriod);

  // 6. Running totals vs logs ------------------------------------------------
  const allocByCharge = new Map();
  for (const p of payments) {
    for (const a of p.allocations ?? []) {
      const k = id(a.chargeId);
      allocByCharge.set(k, (allocByCharge.get(k) ?? 0) + num(a.amount));
    }
  }
  const paidDrift = [];
  for (const c of charges) {
    const allocated = allocByCharge.get(id(c._id)) ?? 0;
    if (!near(c.paidAmount, allocated)) {
      paidDrift.push(
        `Charge ${id(c._id)} [${c.category}] (${where(c)}): paidAmount ${money(c.paidAmount)} ` +
          `vs allocations ${money(allocated)} (diff ${money(num(c.paidAmount) - allocated)})`,
      );
    }
  }
  section("6a. Charge.paidAmount != sum of Payment allocations", paidDrift);

  // ledger.ts treats an expense with an empty payments[] log as legacy: a PAID
  // status means fully settled, otherwise the stored paidAmount stands. Same
  // for withdrawals with an empty returns[] log (returnedAmount stands).
  const legacy = [];
  const expDrift = [];
  for (const e of expenses) {
    const log = e.payments ?? [];
    if (log.length === 0) {
      if (num(e.paidAmount) > 0 || e.status === "PAID") {
        legacy.push(
          `Expense ${id(e._id)} (voucher ${e.voucherNo ?? "?"}, ${where(e)}): no payments log, ` +
            `status ${e.status}, paidAmount ${money(e.paidAmount)} of ${money(e.amount)}`,
        );
      }
      continue;
    }
    const sum = log.reduce((s, x) => s + num(x.amount), 0);
    if (!near(e.paidAmount, sum)) {
      expDrift.push(
        `Expense ${id(e._id)} (voucher ${e.voucherNo ?? "?"}, ${where(e)}): paidAmount ` +
          `${money(e.paidAmount)} vs payments log ${money(sum)} (diff ${money(num(e.paidAmount) - sum)})`,
      );
    }
  }
  section("6b. Expense.paidAmount != sum(payments[].amount)", expDrift);

  const wdDrift = [];
  for (const w of withdrawals) {
    const log = w.returns ?? [];
    if (log.length === 0) {
      if (num(w.returnedAmount) > 0) {
        legacy.push(
          `Withdrawal ${id(w._id)} (${w.takenBy ?? "?"}, ${where(w)}): no returns log, ` +
            `returnedAmount ${money(w.returnedAmount)} of ${money(w.amount)}`,
        );
      }
      continue;
    }
    const sum = log.reduce((s, x) => s + num(x.amount), 0);
    if (!near(w.returnedAmount, sum)) {
      wdDrift.push(
        `Withdrawal ${id(w._id)} (${w.takenBy ?? "?"}, ${where(w)}): returnedAmount ` +
          `${money(w.returnedAmount)} vs returns log ${money(sum)} (diff ${money(num(w.returnedAmount) - sum)})`,
      );
    }
  }
  section("6c. Withdrawal.returnedAmount != sum(returns[].amount)", wdDrift);
  section("6d. Legacy rows with a running total but no per-entry log (skipped above)", legacy, {
    informational: true,
  });

  // 7. Status vs amounts -----------------------------------------------------
  // Mirrors the app: DUE if paid <= 0, PAID if paid >= amount, else PARTIAL.
  const expectedStatus = (paid, amount) =>
    num(paid) <= 0 ? "DUE" : num(paid) + TOL >= num(amount) ? "PAID" : "PARTIAL";
  const statusBad = [];
  for (const c of charges) {
    const want = expectedStatus(c.paidAmount, c.amount);
    const over = num(c.paidAmount) > num(c.amount) + TOL;
    if (c.status !== want || over) {
      statusBad.push(
        `Charge ${id(c._id)} [${c.category}] (${where(c)}): status ${c.status}, ` +
          `paid ${money(c.paidAmount)} of ${money(c.amount)}` +
          (over ? " (OVERPAID)" : ` (expected ${want})`),
      );
    }
  }
  for (const e of expenses) {
    const isLegacy = (e.payments ?? []).length === 0;
    // Legacy PAID with no log is "fully settled" by definition in ledger.ts.
    if (isLegacy && e.status === "PAID") continue;
    const want = expectedStatus(e.paidAmount, e.amount);
    const over = num(e.paidAmount) > num(e.amount) + TOL;
    if (e.status !== want || over) {
      statusBad.push(
        `Expense ${id(e._id)} (voucher ${e.voucherNo ?? "?"}, ${where(e)}): status ${e.status}, ` +
          `paid ${money(e.paidAmount)} of ${money(e.amount)}` +
          (over ? " (OVERPAID)" : ` (expected ${want})`),
      );
    }
  }
  for (const w of withdrawals) {
    if (num(w.returnedAmount) > num(w.amount) + TOL) {
      statusBad.push(
        `Withdrawal ${id(w._id)} (${w.takenBy ?? "?"}, ${where(w)}): returned ` +
          `${money(w.returnedAmount)} exceeds amount ${money(w.amount)}`,
      );
    }
  }
  for (const p of payments) {
    const allocated = (p.allocations ?? []).reduce((s, a) => s + num(a.amount), 0);
    if (!near(allocated, p.totalAmount)) {
      statusBad.push(
        `Payment ${id(p._id)} (${where(p)}): totalAmount ${money(p.totalAmount)} ` +
          `vs allocations ${money(allocated)}`,
      );
    }
  }
  section("7. Status / amount inconsistencies (incl. overpayments, payment total vs allocations)", statusBad);

  // 8. Opening-balance chain -------------------------------------------------
  const chain = [];
  const periodsByBuilding = new Map();
  for (const p of periods) {
    const k = id(p.buildingId);
    if (!periodsByBuilding.has(k)) periodsByBuilding.set(k, []);
    periodsByBuilding.get(k).push(p);
  }
  for (const [bid, list] of periodsByBuilding) {
    list.sort((a, b) => String(a.monthYear).localeCompare(String(b.monthYear)));
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur = list[i];
      if (prev.status !== "CLOSED" || prev.closingBalance == null) continue;
      if (!near(cur.openingBalance, prev.closingBalance)) {
        chain.push(
          `Building "${bName(bid)}": ${cur.monthYear} opening ${money(cur.openingBalance)} ` +
            `!= ${prev.monthYear} closing ${money(prev.closingBalance)} ` +
            `(diff ${money(num(cur.openingBalance) - num(prev.closingBalance))}; period ${id(cur._id)})`,
        );
      }
    }
  }
  section("8. Opening balance != previous closed month's closing balance", chain, {
    informational: true,
  });

  // Sanity: counts straight from the server, to cross-check the loaded data.
  const serverCount = await C.charges.countDocuments({});
  if (serverCount !== charges.length) {
    console.log(
      `\nNote: charges changed during the run (${charges.length} loaded, ${serverCount} now).`,
    );
  }

  // Summary -------------------------------------------------------------------
  console.log("\n=== Summary");
  const width = Math.max(...summary.map((s) => s.title.length));
  for (const s of summary) {
    const tag = s.informational ? "  (info)" : "";
    console.log(`  ${s.title.padEnd(width)}  ${String(s.count).padStart(5)}${tag}`);
  }
  const problems = summary
    .filter((s) => !s.informational)
    .reduce((n, s) => n + s.count, 0);
  console.log(`\nTotal problems (excluding informational): ${problems}`);
}

try {
  await main();
  await mongoose.disconnect();
  process.exit(0);
} catch (err) {
  console.error(`\nIntegrity check failed: ${err instanceof Error ? err.message : err}`);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
}
