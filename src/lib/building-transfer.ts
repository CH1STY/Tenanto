import mongoose from "mongoose";

import { connectDB } from "@/lib/db";
import { Building } from "@/models/Building";
import { Unit } from "@/models/Unit";
import { User } from "@/models/User";
import { Tenancy } from "@/models/Tenancy";
import { MonthlyPeriod } from "@/models/MonthlyPeriod";
import { Charge } from "@/models/Charge";
import { Payment } from "@/models/Payment";
import { Income } from "@/models/Income";
import { Expense } from "@/models/Expense";
import { Withdrawal } from "@/models/Withdrawal";
import { ROLES, PERIOD_STATUS } from "@/lib/constants";

/** Bump when the on-disk export shape changes incompatibly. */
export const BUILDING_EXPORT_VERSION = 1;

type Doc = Record<string, unknown>;

export type BuildingExport = {
  version: number;
  exportedAt: string;
  building: Doc;
  units: Doc[];
  users: Doc[];
  tenancies: Doc[];
  periods: Doc[];
  charges: Doc[];
  payments: Doc[];
  incomes: Doc[];
  expenses: Doc[];
  withdrawals: Doc[];
};

/** Collect a single building and every record that belongs to it. */
export async function exportBuilding(
  buildingId: string,
): Promise<BuildingExport | null> {
  await connectDB();

  const building = await Building.findById(buildingId).lean();
  if (!building) return null;

  const [units, tenancies] = await Promise.all([
    Unit.find({ buildingId }).lean(),
    Tenancy.find({ buildingId }).lean(),
  ]);

  const userIds = [...new Set(tenancies.map((t) => String(t.userId)))];

  const [users, periods, charges, payments, incomes, expenses, withdrawals] =
    await Promise.all([
      User.find({ _id: { $in: userIds }, role: ROLES.TENANT }).lean(),
      MonthlyPeriod.find({ buildingId }).lean(),
      Charge.find({ buildingId }).lean(),
      Payment.find({ buildingId }).lean(),
      Income.find({ buildingId }).lean(),
      Expense.find({ buildingId }).lean(),
      Withdrawal.find({ buildingId }).lean(),
    ]);

  return {
    version: BUILDING_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    building: building as Doc,
    units: units as Doc[],
    users: users as Doc[],
    tenancies: tenancies as Doc[],
    periods: periods as Doc[],
    charges: charges as Doc[],
    payments: payments as Doc[],
    incomes: incomes as Doc[],
    expenses: expenses as Doc[],
    withdrawals: withdrawals as Doc[],
  };
}

const oid = () => new mongoose.Types.ObjectId();

function asArray(value: unknown): Doc[] {
  return Array.isArray(value) ? (value as Doc[]) : [];
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function optStr(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function date(value: unknown, fallback: Date | null): Date | null {
  if (typeof value === "string" || value instanceof Date) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? fallback : d;
  }
  return fallback;
}

function isDuplicateKey(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: number }).code === 11000
  );
}

export type ImportResult =
  | { ok: true; buildingId: string; name: string }
  | { ok: false; error: string };

/**
 * Recreate an exported building as a brand-new building. Every record gets a
 * fresh id and all cross-references are remapped, so the import never collides
 * with existing data and stays fully self-consistent.
 */
export async function importBuilding(
  raw: unknown,
  actorId: string | null,
): Promise<ImportResult> {
  await connectDB();

  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "The file is not a valid building export." };
  }
  const data = raw as Doc;
  const building = data.building as Doc | undefined;
  if (!building || typeof building.name !== "string") {
    return { ok: false, error: "The file is missing building data." };
  }

  const users = asArray(data.users);
  const units = asArray(data.units);
  const tenancies = asArray(data.tenancies);
  const periods = asArray(data.periods);
  const charges = asArray(data.charges);
  const payments = asArray(data.payments);
  const incomes = asArray(data.incomes);
  const expenses = asArray(data.expenses);
  const withdrawals = asArray(data.withdrawals);

  const newBuildingId = oid();
  const userMap = new Map<string, mongoose.Types.ObjectId>();
  const unitMap = new Map<string, mongoose.Types.ObjectId>();
  const tenancyMap = new Map<string, mongoose.Types.ObjectId>();
  const chargeMap = new Map<string, mongoose.Types.ObjectId>();
  for (const u of users) userMap.set(String(u._id), oid());
  for (const u of units) unitMap.set(String(u._id), oid());
  for (const t of tenancies) tenancyMap.set(String(t._id), oid());
  for (const c of charges) chargeMap.set(String(c._id), oid());

  const mapId = (m: Map<string, mongoose.Types.ObjectId>, v: unknown) =>
    m.get(String(v)) ?? null;

  await Building.create({
    _id: newBuildingId,
    name: str(building.name),
    address: optStr(building.address),
    numberOfFloors: num(building.numberOfFloors, 1),
    createdBy: actorId ?? null,
  });

  // Tenants are recreated with new ids; drop a conflicting NID rather than fail.
  for (const u of users) {
    const base = {
      _id: userMap.get(String(u._id)),
      name: str(u.name, "Tenant"),
      phone: optStr(u.phone),
      address: optStr(u.address),
      role: ROLES.TENANT,
      isActive: u.isActive === undefined ? true : Boolean(u.isActive),
    };
    const nid = optStr(u.nid);
    try {
      await User.create(nid ? { ...base, nid } : base);
    } catch (err) {
      if (isDuplicateKey(err)) {
        await User.create(base);
      } else {
        throw err;
      }
    }
  }

  if (units.length > 0) {
    await Unit.insertMany(
      units.map((u) => ({
        _id: unitMap.get(String(u._id)),
        buildingId: newBuildingId,
        floorNumber: num(u.floorNumber),
        label: str(u.label),
        serviceChargeAmount: num(u.serviceChargeAmount),
      })),
      { ordered: false },
    );
  }

  if (tenancies.length > 0) {
    await Tenancy.insertMany(
      tenancies.map((t) => ({
        _id: tenancyMap.get(String(t._id)),
        buildingId: newBuildingId,
        unitId: mapId(unitMap, t.unitId),
        userId: mapId(userMap, t.userId),
        startDate: date(t.startDate, new Date()),
        endDate: date(t.endDate, null),
        isActive: t.isActive === undefined ? true : Boolean(t.isActive),
      })),
      { ordered: false },
    );
  }

  if (periods.length > 0) {
    await MonthlyPeriod.insertMany(
      periods.map((p) => ({
        buildingId: newBuildingId,
        monthYear: str(p.monthYear),
        openingBalance: num(p.openingBalance),
        serviceChargeAmount: num(p.serviceChargeAmount),
        status: str(p.status, PERIOD_STATUS.OPEN),
        closingBalance: p.closingBalance == null ? null : num(p.closingBalance),
        closedAt: date(p.closedAt, null),
        closedBy: null,
        note: optStr(p.note),
        roster: asArray(p.roster)
          .map((r) => ({
            tenancyId: mapId(tenancyMap, r.tenancyId),
            userId: mapId(userMap, r.userId),
            unitId: mapId(unitMap, r.unitId),
            unitLabel: str(r.unitLabel),
            tenantName: str(r.tenantName),
          }))
          .filter((r) => r.tenancyId && r.userId && r.unitId),
      })),
      { ordered: false },
    );
  }

  if (charges.length > 0) {
    await Charge.insertMany(
      charges.map((c) => ({
        _id: chargeMap.get(String(c._id)),
        buildingId: newBuildingId,
        tenancyId: mapId(tenancyMap, c.tenancyId),
        userId: mapId(userMap, c.userId),
        monthYear: str(c.monthYear),
        category: str(c.category),
        description: str(c.description),
        amount: num(c.amount),
        paidAmount: num(c.paidAmount),
        status: str(c.status, "DUE"),
        carriedFrom: optStr(c.carriedFrom),
      })),
      { ordered: false },
    );
  }

  if (payments.length > 0) {
    await Payment.insertMany(
      payments.map((p) => ({
        buildingId: newBuildingId,
        tenancyId: mapId(tenancyMap, p.tenancyId),
        userId: mapId(userMap, p.userId),
        monthYear: str(p.monthYear),
        totalAmount: num(p.totalAmount),
        allocations: asArray(p.allocations)
          .map((a) => ({
            chargeId: mapId(chargeMap, a.chargeId),
            category: str(a.category),
            note: optStr(a.note),
            amount: num(a.amount),
          }))
          .filter((a) => a.chargeId),
        receivedAt: date(p.receivedAt, new Date()),
        recordedBy: actorId ?? null,
      })),
      { ordered: false },
    );
  }

  if (incomes.length > 0) {
    await Income.insertMany(
      incomes.map((i) => ({
        buildingId: newBuildingId,
        monthYear: str(i.monthYear),
        source: str(i.source),
        description: str(i.description),
        amount: num(i.amount),
        receivedAt: date(i.receivedAt, new Date()),
        recordedBy: actorId ?? null,
      })),
      { ordered: false },
    );
  }

  if (expenses.length > 0) {
    await Expense.insertMany(
      expenses.map((e) => ({
        buildingId: newBuildingId,
        monthYear: str(e.monthYear),
        voucherNo: num(e.voucherNo, 1),
        category: optStr(e.category),
        description: str(e.description),
        amount: num(e.amount),
        paidAmount: num(e.paidAmount),
        payments: asArray(e.payments).map((p) => ({
          amount: num(p.amount),
          monthYear: str(p.monthYear),
          at: date(p.at, new Date()),
        })),
        status: str(e.status, "PAID"),
        carriedFrom: optStr(e.carriedFrom),
        paidAt: date(e.paidAt, null),
        recordedBy: actorId ?? null,
      })),
      { ordered: false },
    );
  }

  if (withdrawals.length > 0) {
    await Withdrawal.insertMany(
      withdrawals.map((w) => ({
        buildingId: newBuildingId,
        monthYear: str(w.monthYear),
        takenBy: str(w.takenBy),
        amount: num(w.amount),
        returnedAmount: num(w.returnedAmount),
        returns: asArray(w.returns).map((r) => ({
          amount: num(r.amount),
          monthYear: str(r.monthYear),
          at: date(r.at, new Date()),
        })),
        note: optStr(w.note),
        takenAt: date(w.takenAt, new Date()),
        recordedBy: actorId ?? null,
      })),
      { ordered: false },
    );
  }

  return {
    ok: true,
    buildingId: String(newBuildingId),
    name: str(building.name),
  };
}
