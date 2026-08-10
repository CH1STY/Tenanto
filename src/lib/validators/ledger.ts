import { z } from "zod";
import { objectIdSchema } from "@/lib/validators/building";

const monthYear = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use a valid month (YYYY-MM).");

const money = z.coerce.number().min(0).max(1_000_000_000);
const positiveMoney = z.coerce.number().gt(0, "Amount must be greater than 0.");

export const openMonthSchema = z.object({
  buildingId: objectIdSchema,
  monthYear,
  serviceChargeAmount: money.default(0),
  openingBalance: money.optional(),
});

export const payChargeSchema = z.object({
  buildingId: objectIdSchema,
  monthYear,
  chargeId: objectIdSchema,
  amount: positiveMoney,
});

export const incomeSchema = z.object({
  buildingId: objectIdSchema,
  monthYear,
  source: z.enum(["ROOFTOP_RENT", "ROOFTOP_ELECTRICITY", "CHARITY", "OTHER"]),
  description: z.string().trim().min(1, "Description is required.").max(200),
  amount: positiveMoney,
});

export const expenseSchema = z.object({
  buildingId: objectIdSchema,
  monthYear,
  category: z.string().trim().max(80).optional(),
  description: z.string().trim().min(1, "Description is required.").max(200),
  amount: positiveMoney,
  status: z.enum(["PAID", "DUE"]).default("PAID"),
});

export const withdrawalSchema = z.object({
  buildingId: objectIdSchema,
  monthYear,
  takenBy: z.string().trim().min(1, "Who took the money?").max(120),
  amount: positiveMoney,
  note: z.string().trim().max(200).optional(),
});

export const addChargeSchema = z.object({
  buildingId: objectIdSchema,
  monthYear,
  tenancyId: objectIdSchema,
  category: z.enum(["BILL", "PREVIOUS_DUE"]),
  description: z.string().trim().min(1, "Description is required.").max(200),
  amount: positiveMoney,
});

export const editChargeSchema = z.object({
  buildingId: objectIdSchema,
  monthYear,
  chargeId: objectIdSchema,
  description: z.string().trim().min(1, "Description is required.").max(200),
  amount: positiveMoney,
});

export const chargeRefSchema = z.object({
  buildingId: objectIdSchema,
  monthYear,
  chargeId: objectIdSchema,
});

export const closeMonthSchema = z.object({
  buildingId: objectIdSchema,
  monthYear,
});

export const monthNoteSchema = z.object({
  buildingId: objectIdSchema,
  monthYear,
  note: z.string().trim().max(1000).optional(),
});

/** Identifies a single ledger entry (income, expense, withdrawal, payment). */
export const ledgerEntrySchema = z.object({
  buildingId: objectIdSchema,
  monthYear,
  id: objectIdSchema,
});
