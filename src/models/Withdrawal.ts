import {
  Schema,
  model,
  models,
  type Model,
  type InferSchemaType,
} from "mongoose";

/** A repayment of a withdrawal, recorded in the month the cash came back. */
const WithdrawalReturnSchema = new Schema(
  {
    amount: { type: Number, required: true, min: 0 },
    monthYear: { type: String, required: true },
    at: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

/** Money physically taken out of the cash box by a person (e.g. the owner). */
const WithdrawalSchema = new Schema(
  {
    buildingId: {
      type: Schema.Types.ObjectId,
      ref: "Building",
      required: true,
    },
    monthYear: { type: String, required: true },
    takenBy: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0 },
    // Given back to the building so far; the advance forwards until fully repaid.
    returnedAmount: { type: Number, default: 0, min: 0 },
    returns: { type: [WithdrawalReturnSchema], default: [] },
    note: { type: String, trim: true, default: null },
    takenAt: { type: Date, default: () => new Date() },
    recordedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

WithdrawalSchema.index({ buildingId: 1, monthYear: 1 });

export type WithdrawalDoc = InferSchemaType<typeof WithdrawalSchema>;

export const Withdrawal: Model<WithdrawalDoc> =
  (models.Withdrawal as Model<WithdrawalDoc>) ??
  model<WithdrawalDoc>("Withdrawal", WithdrawalSchema);
