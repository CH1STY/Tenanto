import { Schema, model, models, type Model, type InferSchemaType } from "mongoose";
import { INCOME_SOURCE } from "@/lib/constants";

/** Non-tenant money: rooftop rent, rooftop electricity, charity, other. */
const IncomeSchema = new Schema(
  {
    buildingId: { type: Schema.Types.ObjectId, ref: "Building", required: true },
    monthYear: { type: String, required: true },
    source: {
      type: String,
      enum: Object.values(INCOME_SOURCE),
      required: true,
    },
    description: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0 },
    receivedAt: { type: Date, default: () => new Date() },
    recordedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

IncomeSchema.index({ buildingId: 1, monthYear: 1 });

export type IncomeDoc = InferSchemaType<typeof IncomeSchema>;

export const Income: Model<IncomeDoc> =
  (models.Income as Model<IncomeDoc>) ??
  model<IncomeDoc>("Income", IncomeSchema);
