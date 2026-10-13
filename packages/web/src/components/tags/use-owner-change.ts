"use client";

/**
 * One change to the vocabulary, made from the Tags screen: sent to the app,
 * then said back in a notice, with the screen read again from the server.
 * The notice is a toast because the row a change was made on is often gone
 * once it is made: an accepted proposal leaves the list.
 */
import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";
import { toast } from "@/components/ui/toast";
import { failureMessage, ownerWrite } from "@/lib/owner-write";
import type { OwnerAction } from "@/server/owner-writes";

/** How long a notice of something done stays. One of something refused stays until it is closed. */
const DONE_MS = 7000;

export function useOwnerChange(): {
  /** Makes the change. Resolves to whether it was made. */
  change: (
    action: OwnerAction,
    body: Record<string, unknown>,
  ) => Promise<boolean>;
  /** Whether a change is on its way. */
  busy: boolean;
} {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();
  const change = useCallback(
    async (action: OwnerAction, body: Record<string, unknown>) => {
      setBusy(true);
      try {
        const answer = await ownerWrite(action, body);
        toast.add({
          type: "success",
          title: answer.message,
          timeout: DONE_MS,
        });
        startTransition(() => router.refresh());
        return true;
      } catch (error) {
        toast.add({
          type: "error",
          title: "Nothing was changed",
          description: failureMessage(error),
          priority: "high",
          timeout: 0,
        });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [router],
  );
  return { change, busy };
}
