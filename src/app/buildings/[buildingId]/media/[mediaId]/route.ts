import { connectDB } from "@/lib/db";
import { objectIdSchema } from "@/lib/validators/building";
import { MonthMedia } from "@/models/MonthMedia";
import { requirePublicAccess } from "@/lib/public-access";

type RouteContext = {
  params: Promise<{ buildingId: string; mediaId: string }>;
};

/** Coerce a stored image field to a Node Buffer (lean() yields a BSON Binary). */
function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data && typeof data === "object" && "buffer" in data) {
    return Buffer.from((data as { buffer: Uint8Array }).buffer);
  }
  return Buffer.from(data as ArrayBufferLike);
}

/** Serves attachment bytes to signed-in or PIN-authorized visitors. */
export async function GET(_req: Request, context: RouteContext) {
  await requirePublicAccess();
  const { buildingId, mediaId } = await context.params;
  if (
    !objectIdSchema.safeParse(buildingId).success ||
    !objectIdSchema.safeParse(mediaId).success
  ) {
    return new Response("Not found", { status: 404 });
  }

  await connectDB();

  const media = await MonthMedia.findOne({ _id: mediaId, buildingId })
    .select("data contentType")
    .lean();
  if (!media?.data) return new Response("Not found", { status: 404 });

  const body = new Uint8Array(toBuffer(media.data));

  return new Response(body, {
    headers: {
      "Content-Type": media.contentType || "image/jpeg",
      "Content-Length": String(body.byteLength),
      "Cache-Control": "private, no-store",
    },
  });
}
