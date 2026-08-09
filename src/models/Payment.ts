import { Schema, model, models, type Model, type InferSchemaType } from "mongoose";

const AllocationSchema = new Schema(
  {
    chargeId: { type: Schema.Types.ObjectId, ref: "Charge", required: true },
    category: { type: String, required: true },
    note: { type: String, trim: true, default: null },
    amount: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

/** Money received from a tenant, split across the charges it settles. */
const PaymentSchema = new Schema(
  {
    buildingId: { type: Schema.Types.ObjectId, ref: "Building", required: true },
    tenancyId: { type: Schema.Types.ObjectId, ref: "Tenancy", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    monthYear: { type: String, required: true }, // period the cash was received in
    totalAmount: { type: Number, required: true, min: 0 },
    allocations: { type: [AllocationSchema], default: [] },
    receivedAt: { type: Date, default: () => new Date() },
    recordedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

PaymentSchema.index({ buildingId: 1, monthYear: 1 });
PaymentSchema.index({ tenancyId: 1, monthYear: 1 });

export type PaymentDoc = InferSchemaType<typeof PaymentSchema>;

export const Payment: Model<PaymentDoc> =
  (models.Payment as Model<PaymentDoc>) ??
  model<PaymentDoc>("Payment", PaymentSchema);
