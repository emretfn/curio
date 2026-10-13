import { sharedStore } from "@/server/data";
import { refusePreflight } from "@/server/ingest";
import { handleTaggingStatus } from "@/server/tagging-status";

export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handleTaggingStatus(request, sharedStore());
}

export function OPTIONS(): Response {
  return refusePreflight();
}
