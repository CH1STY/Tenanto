import { headers } from "next/headers";
import { connectDB } from "@/lib/db";
import { AuditLog } from "@/models/AuditLog";
import type { AuditAction } from "@/lib/constants";

export type AuditActor = {
  id?: string | null;
  name?: string | null;
  role?: string | null;
};

export type LogAuditInput = {
  action: AuditAction;
  entity: string;
  entityId?: string | null;
  entityLabel?: string | null;
  actor?: AuditActor;
  buildingId?: string | null;
  description?: string | null;
  before?: unknown;
  after?: unknown;
};

/** Best-effort extraction of client IP + user agent from the incoming request. */
async function requestMeta(): Promise<{
  ip: string | null;
  userAgent: string | null;
}> {
  try {
    const h = await headers();
    const ip =
      h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      h.get("x-real-ip") ||
      null;
    const userAgent = h.get("user-agent") || null;
    return { ip, userAgent };
  } catch {
    return { ip: null, userAgent: null };
  }
}

/**
 * Write a single audit row. Never throws — auditing must not break the primary
 * operation, but failures are surfaced to the server console.
 */
export async function logAudit(input: LogAuditInput): Promise<void> {
  try {
    await connectDB();
    const { ip, userAgent } = await requestMeta();

    await AuditLog.create({
      action: input.action,
      entity: input.entity,
      entityId: input.entityId ?? null,
      entityLabel: input.entityLabel ?? null,
      actorId: input.actor?.id ?? null,
      actorName: input.actor?.name ?? "system",
      actorRole: input.actor?.role ?? null,
      buildingId: input.buildingId ?? null,
      description: input.description ?? null,
      before: input.before ?? null,
      after: input.after ?? null,
      ip,
      userAgent,
    });
  } catch (err) {
    console.error("[audit] failed to write audit log:", err);
  }
}
