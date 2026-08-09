import {
  Schema,
  model,
  models,
  type Model,
  type InferSchemaType,
} from "mongoose";
import { AUDIT_ACTIONS } from "@/lib/constants";

/**
 * Immutable audit trail. Every create/edit/delete across the app writes one row.
 * Actor fields are denormalized (snapshotted) so the log stays readable even if
 * the acting user is later renamed or removed.
 */
const AuditLogSchema = new Schema(
  {
    action: {
      type: String,
      enum: Object.values(AUDIT_ACTIONS),
      required: true,
    },
    // The collection/entity affected, e.g. "User", "Building", "Payment".
    entity: { type: String, required: true, trim: true },
    entityId: { type: Schema.Types.ObjectId, default: null },
    // Human-friendly label of the affected record, e.g. a unit label or a name.
    entityLabel: { type: String, trim: true, default: null },

    // Who performed the action (snapshot + reference).
    actorId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    actorName: { type: String, trim: true, default: "system" },
    actorRole: { type: String, trim: true, default: null },

    // Optional building context to scope/filter logs.
    buildingId: { type: Schema.Types.ObjectId, ref: "Building", default: null },

    // Payloads: state before/after and a summary description.
    description: { type: String, trim: true, default: null },
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },

    // Request metadata.
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Primary filter is by date; secondary by action/entity/actor.
AuditLogSchema.index({ createdAt: -1 });
AuditLogSchema.index({ action: 1, createdAt: -1 });
AuditLogSchema.index({ entity: 1, createdAt: -1 });
AuditLogSchema.index({ actorId: 1, createdAt: -1 });

export type AuditLogDoc = InferSchemaType<typeof AuditLogSchema>;

export const AuditLog: Model<AuditLogDoc> =
  (models.AuditLog as Model<AuditLogDoc>) ??
  model<AuditLogDoc>("AuditLog", AuditLogSchema);
