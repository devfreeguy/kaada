"use client";

import { useEffect } from "react";

import { logFailure } from "./lib/client-log";

/** The last line of defence: the root layout itself crashed. It must bring its own html and body. */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    logFailure("app.crashed", error, { digest: error.digest });
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          padding: "2rem",
          maxWidth: "28rem",
          margin: "0 auto",
        }}
      >
        <h1>Something went wrong</h1>
        <p>
          Kaada hit a problem loading this page. Please try again
          {error.digest ? ` (reference ${error.digest})` : ""}.
        </p>
        <button type="button" onClick={reset}>
          Try again
        </button>
      </body>
    </html>
  );
}
