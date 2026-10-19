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
    <html lang="en" style={{ background: "#051A2F" }}>
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          background: "#051A2F",
          color: "white",
          minHeight: "100dvh",
          padding: "2rem",
          maxWidth: "28rem",
          margin: "0 auto",
        }}
      >
        <h1>Something went wrong</h1>
        <p>
          Kaada hit a problem loading this page. If you already approved an action, check its status
          in your chat before starting again
          {error.digest ? ` (reference ${error.digest})` : ""}.
        </p>
        <button
          type="button"
          onClick={reset}
          style={{
            background: "#9D89FC",
            color: "#051A2F",
            border: 0,
            borderRadius: "999px",
            padding: "1rem 1.5rem",
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
