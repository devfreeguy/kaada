"use client";
import { primaryAction } from "../../components/application/styles";
export function SetupFinalizeStep({
  busy,
  message,
  onFinish,
}: {
  busy: boolean;
  message?: string | undefined;
  onFinish: () => Promise<void>;
}) {
  return (
    <section className="flex flex-col gap-4">
      <h1>Almost done</h1>
      <p className="text-white/75">Your credential is saved. Finish this last step to continue.</p>
      {message && (
        <p role="alert" className="text-white/75">
          {message}
        </p>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => void onFinish()}
        className={primaryAction}
      >
        {busy ? "Finishing setup..." : "Finish setup"}
      </button>
    </section>
  );
}
