import { Schema, model, models, type Model, type InferSchemaType } from "mongoose";
import { PERIOD_STATUS } from "@/lib/constants";

/** A building's ledger for one month (YYYY-MM), OPEN or CLOSED. */
const MonthlyPeriodSchema = new Schema(
  {
    buildingId: { type: Schema.Types.ObjectId, ref: "Building", required: true },
    monthYear: { type: String, required: true }, // YYYY-MM
    openingBalance: { type: Number, required: true, default: 0 },
    serviceChargeAmount: { type: Number, required: true, default: 0 },
    status: {
      type: String,
      enum: Object.values(PERIOD_STATUS),
      default: PERIOD_STATUS.OPEN,
    },
    closingBalance: { type: Number, default: null },
    closedAt: { type: Date, default: null },
    closedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

MonthlyPeriodSchema.index({ buildingId: 1, monthYear: 1 }, { unique: true });

export type MonthlyPeriodDoc = InferSchemaType<typeof MonthlyPeriodSchema>;

export const MonthlyPeriod: Model<MonthlyPeriodDoc> =
  (models.MonthlyPeriod as Model<MonthlyPeriodDoc>) ??
  model<MonthlyPeriodDoc>("MonthlyPeriod", MonthlyPeriodSchema);
