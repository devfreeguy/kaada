import type { Summary } from "./authorization-machine";

/** What the person is approving: what arrives, and the most that can leave. Figures only, plus one line on the estimate. */
export function PaymentSummary({ summary }: { summary: Summary }) {
  const exactOutput = summary.amountMode === "EXACT_OUTPUT";
  return (
    <div className="flex flex-col gap-3">
      <dl className="flex flex-col gap-4 rounded-2xl border border-app-border bg-app-surface-2 p-4">
        <div>
          <dt className="text-sm text-app-muted">
            {summary.recipient ? `${summary.recipient} receives` : "Recipient receives"}
          </dt>
          <dd className="text-xl font-semibold">
            {exactOutput ? "exactly " : "about "}
            {summary.recipientReceives.display}
          </dd>
          {!exactOutput && (
            <dd className="text-sm text-app-muted">at least {summary.minimumReceive.display}</dd>
          )}
        </div>
        <div>
          <dt className="text-sm text-app-muted">Maximum spend</dt>
          <dd className="text-xl font-semibold">{summary.maximumSpend.display}</dd>
          {exactOutput && (
            <dd className="text-sm text-app-muted">about {summary.senderSpends.display}</dd>
          )}
        </div>
      </dl>
      <p className="text-xs text-app-faint">
        Estimate. The final price is confirmed before sending and never exceeds the maximum.
      </p>
    </div>
  );
}
