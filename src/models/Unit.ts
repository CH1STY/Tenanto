import {
  Schema,
  model,
  models,
  type Model,
  type InferSchemaType,
} from "mongoose";

const UnitSchema = new Schema(
  {
    buildingId: {
      type: Schema.Types.ObjectId,
      ref: "Building",
      required: true,
    },
    floorNumber: { type: Number, required: true, min: 0 },
    label: { type: String, required: true, trim: true },
    serviceChargeAmount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

// No duplicate unit label within a building.
UnitSchema.index({ buildingId: 1, label: 1 }, { unique: true });

export type UnitDoc = InferSchemaType<typeof UnitSchema>;

export const Unit: Model<UnitDoc> =
  (models.Unit as Model<UnitDoc>) ?? model<UnitDoc>("Unit", UnitSchema);
