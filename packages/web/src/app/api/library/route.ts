import { sharedStore } from "@/server/data";
import { refusePreflight } from "@/server/ingest";
import { handleLibraryPage } from "@/server/library-page";

export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  return handleLibraryPage(request, sharedStore());
}

export function OPTIONS(): Response {
  return refusePreflight();
}
