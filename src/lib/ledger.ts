import { Types } from "mongoose";
import { connectDB } from "@/lib/db";
import { Payment } from "@/models/Payment";
import { Income } from "@/models/Income";
import { Expense } from "@/models/Expense";
import { Withdrawal } from "@/models/Withdrawal";
import { EXPENSE_STATUS } from "@/lib/constants";

export type PeriodTotals = {
  payments: number;
  income: number;
  expensesPaid: number;
  withdrawals: number;
};

const first = (rows: { s: number }[]) => rows[0]?.s ?? 0;

/** Money totals for a building's month, used for the cash book and closing. */
export async function getPeriodTotals(
  buildingId: string,
  monthYear: string
): Promise<PeriodTotals> {
  await connectDB();
  const buildingObjectId = new Types.ObjectId(buildingId);
  const match = { buildingId: buildingObjectId, monthYear };

  const [payments, income, expensesPaid, withdrawals] = await Promise.all([
    Payment.aggregate<{ s: number }>([
      { $match: match },
      { $group: { _id: null, s: { $sum: "$totalAmount" } } },
    ]),
    Income.aggregate<{ s: number }>([
      { $match: match },
      { $group: { _id: null, s: { $sum: "$amount" } } },
    ]),
    Expense.aggregate<{ s: number }>([
      { $match: { ...match, status: EXPENSE_STATUS.PAID } },
      { $group: { _id: null, s: { $sum: "$amount" } } },
    ]),
    Withdrawal.aggregate<{ s: number }>([
      { $match: match },
      { $group: { _id: null, s: { $sum: "$amount" } } },
    ]),
  ]);

  return {
    payments: first(payments),
    income: first(income),
    expensesPaid: first(expensesPaid),
    withdrawals: first(withdrawals),
  };
}

/** Cash in hand at month end = opening + receipts − paid expenses − withdrawals. */
export function computeClosing(opening: number, t: PeriodTotals): number {
  return opening + t.payments + t.income - t.expensesPaid - t.withdrawals;
}
