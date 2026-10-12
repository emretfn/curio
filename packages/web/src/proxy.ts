import { isLocalHost } from "@/server/guard";

// Runs before every page. No page may be served to a request that reached
// this app under another name (DNS rebinding).
export function proxy(request: Request): Response | undefined {
  if (!isLocalHost(request.headers.get("host"))) {
    return new Response("This app answers only on its local address.", {
      status: 403,
    });
  }
  return undefined;
}

export const config = {
  // The API routes are left out. They make the same check themselves, in
  // refuseUnlessExtension, and a request that passes through this file has
  // its body buffered by Next and cut off at 10 MB, which would truncate a
  // large capture without an error.
  matcher: ["/((?!api/).*)"],
};
