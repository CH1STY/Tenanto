import {
  Schema,
  model,
  models,
  type Model,
  type InferSchemaType,
} from "mongoose";

/** An optimized image attached to one building's monthly period. */
const MonthMediaSchema = new Schema(
  {
    buildingId: {
      type: Schema.Types.ObjectId,
      ref: "Building",
      required: true,
    },
    periodId: {
      type: Schema.Types.ObjectId,
      ref: "MonthlyPeriod",
      required: true,
    },
    monthYear: { type: String, required: true }, // YYYY-MM
    // Optimized image bytes (downscaled + recompressed before saving).
    data: { type: Buffer, required: true },
    contentType: { type: String, required: true },
    filename: { type: String, default: "" },
    size: { type: Number, required: true, default: 0 },
    width: { type: Number, default: 0 },
    height: { type: Number, default: 0 },
    uploadedById: { type: Schema.Types.ObjectId, ref: "User", default: null },
    uploadedByName: { type: String, default: "" },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

MonthMediaSchema.index({ buildingId: 1, monthYear: 1, createdAt: 1 });

export type MonthMediaDoc = InferSchemaType<typeof MonthMediaSchema>;

export const MonthMedia: Model<MonthMediaDoc> =
  (models.MonthMedia as Model<MonthMediaDoc>) ??
  model<MonthMediaDoc>("MonthMedia", MonthMediaSchema);
