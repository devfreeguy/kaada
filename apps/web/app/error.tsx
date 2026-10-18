"use client";

import { useEffect } from "react";

import { logFailure } from "./lib/client-log";

/** A page that crashed while rendering in the browser: reported with its name, message and the digest that matches the server log. */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    logFailure("page.render_failed", error, { digest: error.digest });
  }, [error]);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-4 px-6 py-10">
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p className="text-neutral-600">
        This page hit a problem. Please try again. If it keeps happening, contact support
        {error.digest ? ` and mention reference ${error.digest}` : ""}.
      </p>
      <button type="button" onClick={reset} className="rounded-md bg-black px-4 py-2 text-white">
        Try again
      </button>
    </main>
  );
}
