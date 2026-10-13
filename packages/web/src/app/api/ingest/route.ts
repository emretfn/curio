import { sharedStore, sharedToken } from "@/server/data";
import { handleIngest, refusePreflight } from "@/server/ingest";
import { scheduleTagging } from "@/server/tagging";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleIngest(request, {
    store: sharedStore(),
    token: sharedToken(),
    afterStored: scheduleTagging,
  });
}

export function OPTIONS(): Response {
  return refusePreflight();
}
