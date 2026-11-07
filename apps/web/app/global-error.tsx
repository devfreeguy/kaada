"use client";

import { useEffect } from "react";

import { errorCopy } from "./lib/app-copy";
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
        <h1>{errorCopy.title}</h1>
        <p>{errorCopy.body}</p>
        {error.digest ? (
          <p style={{ fontSize: "0.75rem", opacity: 0.7 }}>Reference: {error.digest}</p>
        ) : null}
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
          {errorCopy.action}
        </button>
      </body>
    </html>
  );
}
