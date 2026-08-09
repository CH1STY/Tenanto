import {
  Schema,
  model,
  models,
  type Model,
  type InferSchemaType,
} from "mongoose";

/**
 * Links a tenant (User) to a Unit for a span of time. Append-only: ending a
 * tenancy sets endDate + isActive=false, it is never deleted, so a tenant's
 * financial history stays attributable even after a unit is reassigned.
 * `buildingId` is denormalized for fast building-scoped lookups.
 */
const TenancySchema = new Schema(
  {
    buildingId: {
      type: Schema.Types.ObjectId,
      ref: "Building",
      required: true,
    },
    unitId: { type: Schema.Types.ObjectId, ref: "Unit", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    startDate: { type: Date, required: true, default: () => new Date() },
    endDate: { type: Date, default: null },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

// Fast "current occupant" lookup and a tenant's history.
TenancySchema.index({ unitId: 1, isActive: 1 });
TenancySchema.index({ userId: 1 });
TenancySchema.index({ buildingId: 1, isActive: 1 });

export type TenancyDoc = InferSchemaType<typeof TenancySchema>;

export const Tenancy: Model<TenancyDoc> =
  (models.Tenancy as Model<TenancyDoc>) ??
  model<TenancyDoc>("Tenancy", TenancySchema);
