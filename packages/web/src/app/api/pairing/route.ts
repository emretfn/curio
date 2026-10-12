import { sharedToken } from "@/server/data";
import { handlePairingCheck, refusePreflight } from "@/server/ingest";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handlePairingCheck(request, sharedToken());
}

export function OPTIONS(): Response {
  return refusePreflight();
}
