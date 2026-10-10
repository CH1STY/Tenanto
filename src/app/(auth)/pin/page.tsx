import { PinForm } from "./pin-form";
import { safePinReturnTo } from "@/lib/public-pin";

export default async function PinPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  const { returnTo } = await searchParams;
  return <PinForm returnTo={safePinReturnTo(returnTo)} />;
}
