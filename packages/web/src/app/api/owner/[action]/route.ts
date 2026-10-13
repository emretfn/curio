import { sharedStore } from "@/server/data";
import { refusePreflight } from "@/server/ingest";
import { handleOwnerWrite } from "@/server/owner-writes";
import { appTagging, scheduleTagging } from "@/server/tagging";

export const dynamic = "force-dynamic";

/**
 * A change the owner makes from one of the app's own pages. Who may send one
 * is `handleOwnerWrite`'s first question, before the body is read.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ action: string }> },
): Promise<Response> {
  const { action } = await params;
  return handleOwnerWrite(request, action, {
    store: sharedStore(),
    // A tag has joined the vocabulary. This asks for the app's pass now:
    // with the app's tagging on it asks the classifier about the bookmarks
    // that mention the tag, and with it off, as the app starts, it sends
    // nothing. The answer says which.
    afterTagAdded: () => scheduleTagging(0),
    appTaggingOn: async () => (await appTagging()).on,
  });
}

export function OPTIONS(): Response {
  return refusePreflight();
}
