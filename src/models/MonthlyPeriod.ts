import {
  Schema,
  model,
  models,
  type Model,
  type InferSchemaType,
} from "mongoose";
import { PERIOD_STATUS } from "@/lib/constants";

/** Immutable snapshot of one tenant on the unit when the month was opened. */
const RosterEntrySchema = new Schema(
  {
    tenancyId: { type: Schema.Types.ObjectId, ref: "Tenancy", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    unitId: { type: Schema.Types.ObjectId, ref: "Unit", required: true },
    unitLabel: { type: String, default: "" },
    tenantName: { type: String, default: "" },
  },
  { _id: false },
);

/** A building's ledger for one month (YYYY-MM), OPEN or CLOSED. */
const MonthlyPeriodSchema = new Schema(
  {
    buildingId: {
      type: Schema.Types.ObjectId,
      ref: "Building",
      required: true,
    },
    monthYear: { type: String, required: true }, // YYYY-MM
    openingBalance: { type: Number, required: true, default: 0 },
    serviceChargeAmount: { type: Number, required: true, default: 0 },
    // Tenants captured at open time; frozen for audit-grade permanence.
    roster: { type: [RosterEntrySchema], default: [] },
    status: {
      type: String,
      enum: Object.values(PERIOD_STATUS),
      default: PERIOD_STATUS.OPEN,
    },
    closingBalance: { type: Number, default: null },
    closedAt: { type: Date, default: null },
    closedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    note: { type: String, default: null },
  },
  { timestamps: true },
);

MonthlyPeriodSchema.index({ buildingId: 1, monthYear: 1 }, { unique: true });

export type MonthlyPeriodDoc = InferSchemaType<typeof MonthlyPeriodSchema>;

export const MonthlyPeriod: Model<MonthlyPeriodDoc> =
  (models.MonthlyPeriod as Model<MonthlyPeriodDoc>) ??
  model<MonthlyPeriodDoc>("MonthlyPeriod", MonthlyPeriodSchema);
