import { Schema, model, models, type Model, type InferSchemaType } from "mongoose";

/** Money physically taken out of the cash box by a person (e.g. the owner). */
const WithdrawalSchema = new Schema(
  {
    buildingId: { type: Schema.Types.ObjectId, ref: "Building", required: true },
    monthYear: { type: String, required: true },
    takenBy: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0 },
    note: { type: String, trim: true, default: null },
    takenAt: { type: Date, default: () => new Date() },
    recordedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

WithdrawalSchema.index({ buildingId: 1, monthYear: 1 });

export type WithdrawalDoc = InferSchemaType<typeof WithdrawalSchema>;

export const Withdrawal: Model<WithdrawalDoc> =
  (models.Withdrawal as Model<WithdrawalDoc>) ??
  model<WithdrawalDoc>("Withdrawal", WithdrawalSchema);
