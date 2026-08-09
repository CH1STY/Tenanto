import { Schema, model, models, type Model, type InferSchemaType } from "mongoose";
import { EXPENSE_STATUS } from "@/lib/constants";

/** Cash paid out (or a payable left DUE), each with an auto voucher number. */
const ExpenseSchema = new Schema(
  {
    buildingId: { type: Schema.Types.ObjectId, ref: "Building", required: true },
    monthYear: { type: String, required: true },
    voucherNo: { type: Number, required: true },
    category: { type: String, trim: true, default: null },
    description: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: Object.values(EXPENSE_STATUS),
      default: EXPENSE_STATUS.PAID,
    },
    carriedFrom: { type: String, default: null },
    paidAt: { type: Date, default: null },
    recordedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

// Sequential vouchers within a building + month.
ExpenseSchema.index(
  { buildingId: 1, monthYear: 1, voucherNo: 1 },
  { unique: true }
);

export type ExpenseDoc = InferSchemaType<typeof ExpenseSchema>;

export const Expense: Model<ExpenseDoc> =
  (models.Expense as Model<ExpenseDoc>) ??
  model<ExpenseDoc>("Expense", ExpenseSchema);
