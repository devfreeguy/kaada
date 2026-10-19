import { api, json } from "../lib/api";
import { logFailure } from "../lib/client-log";
export function watchRecovery(
  token: string,
  executeAfter: string | undefined,
  refresh: (token: string) => Promise<void>,
  onTick: (now: number) => void,
) {
  let active = true;
  let polling = false;
  async function poll() {
    if (!active || polling) return;
    polling = true;
    try {
      if (executeAfter && new Date(executeAfter).getTime() <= Date.now()) {
        await json(await api("/recovery/finalize", token, { method: "POST" }));
      }
    } catch (error) {
      logFailure("recovery.finalize_failed", error);
    }
    try {
      if (active) await refresh(token);
    } finally {
      polling = false;
    }
  }
  const clock = setInterval(() => onTick(Date.now()), 1000);
  const timer = setInterval(() => void poll(), 10_000);
  return () => {
    active = false;
    clearInterval(clock);
    clearInterval(timer);
  };
}
