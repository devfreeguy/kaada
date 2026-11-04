"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { DebugPanel } from "./debug-panel";
import type { Entry, OutboundAction, PlaygroundSession, PlaygroundTurn } from "./types";

/*
 * The playground's chat.
 *
 * It types messages and presses buttons; it decides nothing. A button press is sent as the opaque handle the server issued
 * (the same value Telegram would put in callback_data), never as text, so the real callback path is what gets exercised.
 */

const API = "/api/v1/dev/playground";

const EXAMPLES = [
  "/rates Naira to Argentina Peso",
  "What's the rate from Naira to Argentine pesos?",
  "How much is ₦20,000 in Argentine pesos?",
  "What about 20,000?",
  "Send 500 AR$ to Maria",
  "Send João exactly R$500",
  "How much is 2000 pesos in naira?",
];

let nextId = 0;
const entryId = () => `e${String(++nextId)}`;

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? "The playground is not enabled on the API. Set AGENT_PLAYGROUND=true and restart it."
        : `The API answered ${String(response.status)}.`,
    );
  }
  return (await response.json()) as T;
}

export function Playground() {
  const [session, setSession] = useState<PlaygroundSession | null>(null);
  // The session is minted by the server on first use, not on mount: a developer opening the page should not create a record
  // just by looking at it, and the first message creates one anyway.
  const [entries, setEntries] = useState<Entry[]>([
    {
      id: entryId(),
      from: "system",
      text: "Send a message to start. This session gets its own identity and chat, shares nothing with any other session, and cannot execute a transaction.",
    },
  ]);
  const [selected, setSelected] = useState<PlaygroundTurn | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const startSession = useCallback(async (announce: boolean) => {
    setError(null);
    try {
      const fresh = await post<PlaygroundSession>("session", {});
      setSession(fresh);
      setEntries(
        announce
          ? [
              {
                id: entryId(),
                from: "system",
                text: "New conversation. This session has its own identity and chat; nothing is shared with any other session, and no transaction can be executed here.",
              },
            ]
          : [],
      );
      setSelected(null);
      return fresh;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not start a session.");
      return null;
    }
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [entries]);

  /** Shows a finished turn: everything Kaada said, plus the simulation note where there is one. */
  const absorb = useCallback((turn: PlaygroundTurn) => {
    const replies: Entry[] = turn.messages.map((message) => ({
      id: entryId(),
      from: "kaada",
      text: message.text,
      ...(message.actions && message.actions.length > 0 && { actions: message.actions }),
      turn,
    }));
    if (turn.simulationNote) {
      replies.push({ id: entryId(), from: "system", text: turn.simulationNote, turn });
    }
    if (replies.length === 0) {
      replies.push({
        id: entryId(),
        from: "system",
        text: `The turn finished with "${turn.result}" and said nothing.`,
        turn,
      });
    }
    setEntries((current) => [...current, ...replies]);
    setSelected(turn);
  }, []);

  const send = useCallback(
    async (message: string) => {
      const active = session ?? (await startSession(false));
      if (!active || message.trim() === "") return;
      setBusy(true);
      setError(null);
      setEntries((current) => [...current, { id: entryId(), from: "you", text: message }]);
      try {
        absorb(
          await post<PlaygroundTurn>("message", {
            sessionId: active.sessionId,
            conversationId: active.conversationId,
            text: message,
          }),
        );
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "The turn failed.");
      } finally {
        setBusy(false);
      }
    },
    [absorb, session, startSession],
  );

  /** A pressed inline button: the handle goes back as a callback, exactly as Telegram would send it. */
  const press = useCallback(
    async (action: OutboundAction) => {
      if (!session || !action.handle) return;
      setBusy(true);
      setError(null);
      setEntries((current) => [
        ...current,
        { id: entryId(), from: "you", text: `▸ ${action.label}` },
      ]);
      try {
        absorb(
          await post<PlaygroundTurn>("action", {
            sessionId: session.sessionId,
            conversationId: session.conversationId,
            handle: action.handle,
          }),
        );
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "The callback failed.");
      } finally {
        setBusy(false);
      }
    },
    [absorb, session],
  );

  return (
    <main className="flex h-dvh flex-col bg-neutral-900 text-neutral-100">
      <header className="flex flex-wrap items-center gap-3 border-b border-neutral-800 px-4 py-2">
        <h1 className="text-sm font-semibold">Kaada agent playground</h1>
        <span className="rounded bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-400">
          sandbox · execution disabled
        </span>
        <span className="hidden text-[11px] text-neutral-500 sm:inline">
          {session ? `session ${session.sessionId.slice(0, 11)}…` : "starting…"}
        </span>
        <button
          type="button"
          onClick={() => void startSession(true)}
          className="ml-auto rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800"
        >
          New conversation
        </button>
      </header>

      {error ? (
        <p className="border-b border-red-900 bg-red-950/50 px-4 py-2 text-xs text-red-300">
          {error}
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
            {entries.map((entry) => (
              <div
                key={entry.id}
                className={entry.from === "you" ? "flex justify-end" : "flex justify-start"}
              >
                <div
                  className={[
                    "max-w-184 rounded-lg px-3 py-2 text-sm whitespace-pre-wrap",
                    entry.from === "you"
                      ? "bg-sky-700 text-white"
                      : entry.from === "system"
                        ? "border border-amber-700/40 bg-amber-500/10 text-amber-200"
                        : "bg-neutral-800 text-neutral-100",
                  ].join(" ")}
                  onClick={() => entry.turn && setSelected(entry.turn)}
                >
                  <p>{entry.text}</p>
                  {entry.actions ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {entry.actions.map((action, index) => {
                        const callback = action.type === "ACTION" && action.handle;
                        return (
                          <button
                            key={`${entry.id}-${String(index)}`}
                            type="button"
                            disabled={!callback || busy}
                            title={
                              callback
                                ? (action.description ?? action.label)
                                : "Opens a real Kaada page: disabled in the playground"
                            }
                            onClick={(e) => {
                              e.stopPropagation();
                              if (callback) void press(action);
                            }}
                            className={[
                              "rounded border px-2 py-1 text-xs",
                              callback
                                ? "border-neutral-600 hover:bg-neutral-700"
                                : "cursor-not-allowed border-neutral-800 text-neutral-500 line-through",
                            ].join(" ")}
                          >
                            {action.label}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
            {busy ? <p className="text-xs text-neutral-500">Kaada is thinking…</p> : null}
            <div ref={endRef} />
          </div>

          <div className="border-t border-neutral-800 p-3">
            <div className="mb-2 flex flex-wrap gap-1.5">
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  disabled={busy}
                  onClick={() => void send(example)}
                  className="rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
                >
                  {example}
                </button>
              ))}
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const message = text;
                setText("");
                void send(message);
              }}
              className="flex gap-2"
            >
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={busy}
                placeholder="Message Kaada, or type a command like /rates"
                className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-neutral-500"
              />
              <button
                type="submit"
                disabled={busy || text.trim() === ""}
                className="rounded bg-sky-700 px-4 py-2 text-sm font-medium disabled:opacity-40"
              >
                Send
              </button>
            </form>
          </div>
        </section>

        <aside className="flex min-h-0 w-full flex-col border-t border-neutral-800 lg:w-120 lg:border-l lg:border-t-0">
          <h2 className="border-b border-neutral-800 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
            What happened
          </h2>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <DebugPanel turn={selected} />
          </div>
        </aside>
      </div>
    </main>
  );
}
