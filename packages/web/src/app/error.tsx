"use client";

/**
 * What a screen shows when the server could not draw it: after a change,
 * for one, when the page is read again and that reading fails. A change is
 * stored before the page is read again, so nothing the owner did is lost,
 * and the screen says so and offers to try again.
 *
 * The error's own words are not shown. They can quote what the server was
 * working on, a bookmark's text among it; they are in the server's log,
 * under the reference given here.
 */
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";

export default function ScreenError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <main
      role="alert"
      data-testid="screen-error"
      className="mx-auto flex max-w-md flex-col items-start gap-4 px-4 py-16 sm:px-6"
    >
      <h1 className="font-semibold text-xl tracking-[-0.01em]">
        This screen could not be drawn
      </h1>
      <p className="text-[0.9375rem] text-muted-foreground leading-normal">
        The app could not read the library for it just now. Nothing was lost: a
        change you made before this was stored before the screen was read again.
        Check that the app is still running, then try again.
      </p>
      {error.digest !== undefined ? (
        <p className="text-[0.8125rem] text-muted-foreground">
          The app’s log has the reason, under{" "}
          <code className="font-mono text-foreground">{error.digest}</code>.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => retry()}>Try again</Button>
        <Link
          href="/"
          prefetch={false}
          className={buttonVariants({ variant: "outline" })}
        >
          Back to the library
        </Link>
      </div>
    </main>
  );
}
