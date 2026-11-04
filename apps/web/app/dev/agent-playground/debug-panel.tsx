"use client";

import { useState } from "react";

import type { PlaygroundTurn } from "./types";

/*
 * What the application actually did, for the selected turn.
 *
 * Everything here is structured data the API produced: the stored intent row, the agent's own structured answers, the
 * conversation's focus, the simulated execution event and the events the services logged. Nothing is reconstructed in the
 * browser, and credentials are already removed server-side before they reach this page.
 */

function Section({
  title,
  children,
  open = false,
}: {
  title: string;
  children: React.ReactNode;
  open?: boolean;
}) {
  return (
    <details open={open} className="border-b border-neutral-800">
      <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-400 hover:text-neutral-200">
        {title}
      </summary>
      <div className="px-3 pb-3">{children}</div>
    </details>
  );
}

function Json({ value }: { value: unknown }) {
  return (
    <pre className="overflow-x-auto rounded bg-neutral-950 p-2 text-[11px] leading-relaxed text-neutral-300">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-2 py-0.5 text-xs">
      <span className="w-36 shrink-0 text-neutral-500">{label}</span>
      <span className="break-all text-neutral-200">{value}</span>
    </div>
  );
}

export function DebugPanel({ turn }: { turn: PlaygroundTurn | null }) {
  const [filter, setFilter] = useState("");
  if (!turn) {
    return (
      <p className="p-4 text-xs text-neutral-500">
        Send a message, then select any turn to see what the application did.
      </p>
    );
  }

  const intent = turn.intent;
  const events = turn.trace.filter(
    (event) => filter === "" || event.event.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div className="divide-y divide-neutral-800">
      <Section title="Turn" open>
        <Row label="result" value={turn.result} />
        <Row label="elapsed" value={`${String(turn.elapsedMs)} ms`} />
        <Row label="messages sent" value={turn.messages.length} />
      </Section>

      <Section title="Intent and entities" open>
        {intent ? (
          <>
            <Row label="type" value={intent.type} />
            <Row label="status" value={intent.status} />
            <Row label="revision" value={intent.revision} />
            <Row
              label="missing"
              value={intent.missingFields.length > 0 ? intent.missingFields.join(", ") : "nothing"}
            />
            {intent.destinationCountry ? (
              <Row label="country" value={intent.destinationCountry} />
            ) : null}
            {intent.sourceAssetId ? <Row label="source asset" value={intent.sourceAssetId} /> : null}
            {intent.destinationAssetId ? (
              <Row label="destination asset" value={intent.destinationAssetId} />
            ) : null}
            {intent.recipientId ? <Row label="recipient" value={intent.recipientId} /> : null}
            <p className="mt-2 text-[11px] text-neutral-500">What the language step read:</p>
            <Json value={intent.parsed} />
            <p className="mt-2 text-[11px] text-neutral-500">
              Resolved amount (exact smallest units):
            </p>
            <Json value={intent.amount} />
          </>
        ) : (
          <p className="text-xs text-neutral-500">
            No intent was recorded: this turn was conversational.
          </p>
        )}
      </Section>

      <Section title="Conversation focus">
        {turn.focus ? (
          <Json value={turn.focus} />
        ) : (
          <p className="text-xs text-neutral-500">Nothing pending.</p>
        )}
      </Section>

      <Section title="Simulated execution" open={turn.simulated !== null}>
        {turn.simulated ? (
          <>
            <p className="mb-2 text-xs text-amber-400">
              Nothing was executed. This is what the application would have done.
            </p>
            <Json value={turn.simulated} />
          </>
        ) : (
          <p className="text-xs text-neutral-500">
            This turn proposed no financial operation.
          </p>
        )}
      </Section>

      <Section title="Agent responses">
        <Json value={turn.responses} />
      </Section>

      <Section title={`Execution trace (${String(turn.trace.length)})`}>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter events"
          className="mb-2 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-200 outline-none focus:border-neutral-500"
        />
        <ol className="space-y-1">
          {events.map((event, index) => (
            <li key={`${event.event}-${String(index)}`} className="rounded bg-neutral-950 p-2">
              <div className="flex items-baseline justify-between gap-2">
                <span
                  className={
                    event.level === "error"
                      ? "text-xs font-medium text-red-400"
                      : event.level === "warn"
                        ? "text-xs font-medium text-amber-400"
                        : "text-xs font-medium text-neutral-200"
                  }
                >
                  {event.event}
                </span>
                <span className="shrink-0 text-[10px] text-neutral-500">+{event.atMs}ms</span>
              </div>
              {Object.keys(event.fields).length > 0 ? <Json value={event.fields} /> : null}
            </li>
          ))}
          {events.length === 0 ? (
            <li className="text-xs text-neutral-500">No events matched.</li>
          ) : null}
        </ol>
      </Section>
    </div>
  );
}
