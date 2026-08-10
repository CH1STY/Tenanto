import {
  Schema,
  model,
  models,
  type Model,
  type InferSchemaType,
} from "mongoose";
import { EXPENSE_STATUS } from "@/lib/constants";

/** A payment made against an expense, recorded in the month cash went out. */
const ExpensePaymentSchema = new Schema(
  {
    amount: { type: Number, required: true, min: 0 },
    monthYear: { type: String, required: true },
    at: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

/** Cash paid out (or a payable left DUE), each with an auto voucher number. */
const ExpenseSchema = new Schema(
  {
    buildingId: {
      type: Schema.Types.ObjectId,
      ref: "Building",
      required: true,
    },
    monthYear: { type: String, required: true },
    voucherNo: { type: Number, required: true },
    category: { type: String, trim: true, default: null },
    description: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0 },
    // Paid so far; a payable forwards until fully paid.
    paidAmount: { type: Number, default: 0, min: 0 },
    payments: { type: [ExpensePaymentSchema], default: [] },
    status: {
      type: String,
      enum: Object.values(EXPENSE_STATUS),
      default: EXPENSE_STATUS.PAID,
    },
    carriedFrom: { type: String, default: null },
    paidAt: { type: Date, default: null },
    recordedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

// Sequential vouchers within a building + month.
ExpenseSchema.index(
  { buildingId: 1, monthYear: 1, voucherNo: 1 },
  { unique: true },
);

export type ExpenseDoc = InferSchemaType<typeof ExpenseSchema>;

export const Expense: Model<ExpenseDoc> =
  (models.Expense as Model<ExpenseDoc>) ??
  model<ExpenseDoc>("Expense", ExpenseSchema);
