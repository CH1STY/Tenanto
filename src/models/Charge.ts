import {
  Schema,
  model,
  models,
  type Model,
  type InferSchemaType,
} from "mongoose";
import { CHARGE_CATEGORY, CHARGE_STATUS } from "@/lib/constants";

/** An edit to a due, logged with the month it was made so past months stay put. */
const ChargeAdjustmentSchema = new Schema(
  {
    monthYear: { type: String, required: true },
    amount: { type: Number, required: true, min: 0 },
    description: { type: String, required: true, trim: true },
    prevAmount: { type: Number, required: true, min: 0 },
    prevDescription: { type: String, required: true, trim: true },
    by: { type: String, default: null },
    at: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

/** Anything a tenant owes: a service charge, a previous due, or a bill. */
const ChargeSchema = new Schema(
  {
    buildingId: {
      type: Schema.Types.ObjectId,
      ref: "Building",
      required: true,
    },
    tenancyId: { type: Schema.Types.ObjectId, ref: "Tenancy", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    monthYear: { type: String, required: true },
    category: {
      type: String,
      enum: Object.values(CHARGE_CATEGORY),
      required: true,
    },
    description: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0 },
    paidAmount: { type: Number, default: 0, min: 0 },
    status: {
      type: String,
      enum: Object.values(CHARGE_STATUS),
      default: CHARGE_STATUS.DUE,
    },
    // Edit history; each entry's amount takes effect from its own month onward.
    adjustments: { type: [ChargeAdjustmentSchema], default: [] },
    carriedFrom: { type: String, default: null },
  },
  { timestamps: true },
);

// One service charge per month per tenancy.
ChargeSchema.index(
  { tenancyId: 1, monthYear: 1, category: 1 },
  {
    unique: true,
    partialFilterExpression: { category: CHARGE_CATEGORY.SERVICE_CHARGE },
  },
);
ChargeSchema.index({ tenancyId: 1, status: 1 });

export type ChargeDoc = InferSchemaType<typeof ChargeSchema>;

export const Charge: Model<ChargeDoc> =
  (models.Charge as Model<ChargeDoc>) ??
  model<ChargeDoc>("Charge", ChargeSchema);
