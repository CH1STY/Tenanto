import { z } from "zod";
import { objectIdSchema } from "@/lib/validators/building";

export const managerCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(120),
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters.")
    .max(200),
  buildingIds: z.array(objectIdSchema).default([]),
});

export const managerActiveSchema = z.object({
  userId: objectIdSchema,
  active: z.enum(["true", "false"]),
});

export const managerBuildingsSchema = z.object({
  userId: objectIdSchema,
  buildingIds: z.array(objectIdSchema).default([]),
});

export const managerPasswordSchema = z.object({
  userId: objectIdSchema,
  password: z
    .string()
    .min(8, "Password must be at least 8 characters.")
    .max(200),
});
