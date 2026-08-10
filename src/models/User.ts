import {
  Schema,
  model,
  models,
  type Model,
  type InferSchemaType,
} from "mongoose";
import { ROLES } from "@/lib/constants";

const UserSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    // National ID — required for tenants, not for SuperAdmin. Omitted (absent),
    // not null, when unused so the unique index only applies to real values.
    nid: { type: String, trim: true },
    address: { type: String, trim: true, default: null },
    phone: { type: String, trim: true, default: null },
    // Login users only (SUPER_ADMIN, MANAGER). Omitted when unused.
    email: { type: String, trim: true, lowercase: true },
    passwordHash: { type: String, default: null, select: false },
    role: {
      type: String,
      enum: Object.values(ROLES),
      required: true,
      default: ROLES.TENANT,
    },
    isActive: { type: Boolean, default: true },
    activeBuildingId: {
      type: Schema.Types.ObjectId,
      ref: "Building",
      default: null,
    },
    // Buildings a MANAGER is allowed to manage (SuperAdmin-assigned).
    managedBuildingIds: {
      type: [Schema.Types.ObjectId],
      ref: "Building",
      default: [],
    },
  },
  { timestamps: true },
);

// Unique only for real string values — a partial index correctly ignores
// documents where the field is absent or null (many tenants have no email).
UserSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: "string" } } },
);
UserSchema.index(
  { nid: 1 },
  { unique: true, partialFilterExpression: { nid: { $type: "string" } } },
);

export type UserDoc = InferSchemaType<typeof UserSchema>;

export const User: Model<UserDoc> =
  (models.User as Model<UserDoc>) ?? model<UserDoc>("User", UserSchema);
