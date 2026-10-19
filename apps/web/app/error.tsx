"use client";

import { useEffect } from "react";

import { logFailure } from "./lib/client-log";
import { ApplicationShell } from "./components/application/application-shell";
import { ApplicationFailure } from "./components/application/application-failure";

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
    <ApplicationShell label="We’re here to help.">
      <ApplicationFailure reference={error.digest} reset={reset} />
    </ApplicationShell>
  );
}
