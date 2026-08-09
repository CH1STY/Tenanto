import {
  Schema,
  model,
  models,
  type Model,
  type InferSchemaType,
} from "mongoose";

const BuildingSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    address: { type: String, trim: true, default: null },
    numberOfFloors: { type: Number, required: true, min: 1 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

export type BuildingDoc = InferSchemaType<typeof BuildingSchema>;

export const Building: Model<BuildingDoc> =
  (models.Building as Model<BuildingDoc>) ??
  model<BuildingDoc>("Building", BuildingSchema);
