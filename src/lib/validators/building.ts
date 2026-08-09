import { z } from "zod";

/** A 24-char hex MongoDB ObjectId. Guards against NoSQL injection via ids. */
export const objectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, "Invalid id.");

export const buildingCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(120),
  address: z.string().trim().max(300).optional(),
  numberOfFloors: z.coerce
    .number()
    .int("Floors must be a whole number.")
    .min(1, "At least 1 floor.")
    .max(200, "Too many floors."),
  // Comma-separated side labels used to auto-generate units, e.g. "A,B".
  unitLabels: z.string().trim().max(200).optional(),
  serviceChargeAmount: z.coerce.number().min(0).max(100_000_000).default(0),
});

export const buildingUpdateSchema = z.object({
  buildingId: objectIdSchema,
  name: z.string().trim().min(1, "Name is required.").max(120),
  address: z.string().trim().max(300).optional(),
  numberOfFloors: z.coerce.number().int().min(1).max(200),
});

export const unitCreateSchema = z.object({
  buildingId: objectIdSchema,
  floorNumber: z.coerce.number().int().min(0).max(300),
  label: z.string().trim().min(1, "Label is required.").max(30),
  serviceChargeAmount: z.coerce.number().min(0).max(100_000_000).default(0),
});

export const unitUpdateSchema = z.object({
  unitId: objectIdSchema,
  floorNumber: z.coerce.number().int().min(0).max(300),
  label: z.string().trim().min(1, "Label is required.").max(30),
  serviceChargeAmount: z.coerce.number().min(0).max(100_000_000).default(0),
});
