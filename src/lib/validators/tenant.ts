import { z } from "zod";
import { objectIdSchema } from "@/lib/validators/building";

const monthYear = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use a valid month (YYYY-MM).");

const positiveMoney = z.coerce.number().gt(0, "Amount must be greater than 0.");

// Assign a tenant to a unit — either an existing tenant (existingUserId) or a
// brand-new one (name + nid required). superRefine enforces the right fields.
export const tenantPlaceSchema = z
  .object({
    buildingId: objectIdSchema,
    unitId: objectIdSchema,
    existingUserId: z
      .string()
      .trim()
      .regex(/^[a-f\d]{24}$/i, "Invalid tenant selected.")
      .optional()
      .or(z.literal("")),
    name: z.string().trim().max(120).optional(),
    nid: z.string().trim().max(50).optional(),
    phone: z.string().trim().max(30).optional(),
    address: z.string().trim().max(300).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.existingUserId) return;
    if (!val.name || val.name.length < 1) {
      ctx.addIssue({
        code: "custom",
        path: ["name"],
        message: "Tenant name is required.",
      });
    }
  });

export const vacateSchema = z.object({
  unitId: objectIdSchema,
});

export const tenantActiveSchema = z.object({
  userId: objectIdSchema,
  active: z.enum(["true", "false"]),
});

// A due added by hand (previous balance, a bill, or anything else).
export const manualChargeSchema = z.object({
  buildingId: objectIdSchema,
  userId: objectIdSchema,
  category: z.enum(["PREVIOUS_DUE", "BILL", "OTHER"]),
  monthYear,
  description: z.string().trim().min(1, "Description is required.").max(200),
  amount: positiveMoney,
});

export const deleteChargeSchema = z.object({
  buildingId: objectIdSchema,
  chargeId: objectIdSchema,
});
