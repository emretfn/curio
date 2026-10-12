import { sharedStore, sharedToken } from "@/server/data";
import { handleIngest, refusePreflight } from "@/server/ingest";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleIngest(request, { store: sharedStore(), token: sharedToken() });
}

export function OPTIONS(): Response {
  return refusePreflight();
}
