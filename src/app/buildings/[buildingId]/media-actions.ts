"use server";

import { revalidatePath } from "next/cache";

import { connectDB } from "@/lib/db";
import {
  requireRole,
  requireSuperAdmin,
  userManagesBuilding,
} from "@/lib/rbac";
import { logAudit } from "@/lib/audit";
import { ROLES, AUDIT_ACTIONS, PERIOD_STATUS } from "@/lib/constants";
import { shortDate } from "@/lib/dates";
import { objectIdSchema } from "@/lib/validators/building";
import { MonthlyPeriod } from "@/models/MonthlyPeriod";
import { MonthMedia } from "@/models/MonthMedia";
import { requirePublicAccess } from "@/lib/public-access";

export type MediaItem = {
  id: string;
  filename: string;
  contentType: string;
  width: number;
  height: number;
  size: number;
  uploadedByName: string;
  createdAt: string;
};

export type MediaActionResult =
  | { error: null; media: MediaItem[] }
  | { error: string; media?: undefined };

const MONTH_YEAR = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_BYTES = 6 * 1024 * 1024; // 6 MB safety cap on the optimized upload.

/** Verify real image content via magic bytes; returns the MIME type or null. */
function sniffImageType(bytes: Buffer): string | null {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
    return "image/png";
  if (bytes.length >= 6 && bytes.toString("ascii", 0, 6).match(/^GIF8[79]a$/))
    return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  return null;
}

function serialize(
  docs: {
    _id: unknown;
    filename?: string | null;
    contentType?: string | null;
    width?: number | null;
    height?: number | null;
    size?: number | null;
    uploadedByName?: string | null;
    createdAt?: Date | string;
  }[],
): MediaItem[] {
  return docs.map((d) => ({
    id: String(d._id),
    filename: d.filename ?? "",
    contentType: d.contentType ?? "image/jpeg",
    width: d.width ?? 0,
    height: d.height ?? 0,
    size: d.size ?? 0,
    uploadedByName: d.uploadedByName ?? "",
    createdAt: d.createdAt ? shortDate(d.createdAt) : "",
  }));
}

async function listMedia(
  buildingId: string,
  monthYear: string,
): Promise<MediaItem[]> {
  const docs = await MonthMedia.find({ buildingId, monthYear })
    .select("-data")
    .sort({ createdAt: 1 })
    .lean();
  return serialize(docs);
}

/** Public: media metadata for a building month (bytes are served by the route). */
export async function loadMonthMedia(
  buildingId: string,
  monthYear: string,
): Promise<MediaItem[]> {
  await requirePublicAccess();
  if (!objectIdSchema.safeParse(buildingId).success) return [];
  if (!MONTH_YEAR.test(monthYear)) return [];
  await connectDB();
  return listMedia(buildingId, monthYear);
}

/** Admin/Manager: attach an already-optimized image to a month. */
export async function uploadMonthMedia(
  buildingId: string,
  monthYear: string,
  formData: FormData,
): Promise<MediaActionResult> {
  let actor;
  try {
    actor = await requireRole(ROLES.SUPER_ADMIN, ROLES.MANAGER);
  } catch {
    return { error: "Only an Admin or Super Admin can add files." };
  }

  if (!objectIdSchema.safeParse(buildingId).success)
    return { error: "Invalid building." };
  if (!MONTH_YEAR.test(monthYear)) return { error: "Invalid month." };

  await connectDB();

  if (!(await userManagesBuilding(buildingId, actor))) {
    return { error: "You do not manage this building." };
  }

  const period = await MonthlyPeriod.findOne({ buildingId, monthYear })
    .select("_id")
    .lean();
  if (!period) return { error: "That month is not open." };

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Choose an image to upload." };
  }
  if (file.size > MAX_BYTES) {
    return { error: "Image is too large after optimization (max 6 MB)." };
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const contentType = sniffImageType(bytes);
  if (!contentType) {
    return { error: "Only image files are allowed." };
  }

  const width = Number(formData.get("width")) || 0;
  const height = Number(formData.get("height")) || 0;

  const created = await MonthMedia.create({
    buildingId,
    periodId: period._id,
    monthYear,
    data: bytes,
    contentType,
    filename: file.name?.slice(0, 200) ?? "image",
    size: bytes.length,
    width,
    height,
    uploadedById: actor.id,
    uploadedByName: actor.name ?? "",
  });

  await logAudit({
    action: AUDIT_ACTIONS.CREATE,
    entity: "MonthMedia",
    entityId: String(created._id),
    entityLabel: `${monthYear} · ${created.filename}`,
    actor: { id: actor.id, name: actor.name, role: actor.role },
    buildingId,
    description: `Attached image to ${monthYear}`,
  });

  revalidatePath(`/buildings/${buildingId}`);
  revalidatePath(`/admin/buildings/${buildingId}/ledger`);
  return { error: null, media: await listMedia(buildingId, monthYear) };
}

/** Super Admin only, and only while the month is open. */
export async function deleteMonthMedia(
  buildingId: string,
  monthYear: string,
  mediaId: string,
): Promise<MediaActionResult> {
  let actor;
  try {
    actor = await requireSuperAdmin();
  } catch {
    return { error: "Only a Super Admin can delete files." };
  }

  if (
    !objectIdSchema.safeParse(buildingId).success ||
    !objectIdSchema.safeParse(mediaId).success
  ) {
    return { error: "Invalid request." };
  }
  if (!MONTH_YEAR.test(monthYear)) return { error: "Invalid month." };

  await connectDB();

  const period = await MonthlyPeriod.findOne({ buildingId, monthYear })
    .select("status")
    .lean();
  if (!period) return { error: "That month does not exist." };
  if (period.status !== PERIOD_STATUS.OPEN) {
    return { error: "Files can only be deleted while the month is open." };
  }

  const media = await MonthMedia.findOne({ _id: mediaId, buildingId }).select(
    "filename monthYear",
  );
  if (!media) return { error: "File not found." };
  if (media.monthYear !== monthYear) return { error: "File not found." };

  await media.deleteOne();

  await logAudit({
    action: AUDIT_ACTIONS.DELETE,
    entity: "MonthMedia",
    entityId: mediaId,
    entityLabel: `${monthYear} · ${media.filename}`,
    actor: { id: actor.id, name: actor.name, role: actor.role },
    buildingId,
    description: `Deleted image from ${monthYear}`,
  });

  revalidatePath(`/buildings/${buildingId}`);
  revalidatePath(`/admin/buildings/${buildingId}/ledger`);
  return { error: null, media: await listMedia(buildingId, monthYear) };
}
