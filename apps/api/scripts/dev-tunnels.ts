/*
 * Development only. Opens two public HTTPS tunnels with cloudflared (the API on :4000 for Telegram's webhook, the web app on :3000
 * for the secure setup/authorize pages that Telegram buttons open), waits until both are really connected, and writes the matching
 * values into the repository's .env:
 *
 *   WEB_URL, CORS_ORIGINS, PASSKEY_ORIGIN   https://<web-host>
 *   PASSKEY_RP_ID                           <web-host>      (a WebAuthn RP ID is the origin's host, not a label of it)
 *   TELEGRAM_WEBHOOK_URL                    https://<api-host>/api/v1/channels/telegram/webhook
 *
 * trycloudflare hostnames change every time, and a passkey is bound to its RP ID, so wallets created under one hostname cannot be
 * used under the next: use throw-away test wallets. Nothing here touches production settings or the credential architecture; it
 * only fills environment values. It prints hostnames, never secrets. Leave it running; Ctrl+C closes the tunnels.
 *
 *   pnpm --filter @kaada/api dev:tunnels
 *   (then restart the API and run: pnpm --filter @kaada/api telegram:webhook set)
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const ENV_FILE = new URL("../../../.env", import.meta.url);
const WEBHOOK_PATH = "/api/v1/channels/telegram/webhook";
// HTTP/2 over TCP works where QUIC over UDP is blocked, which is why a default tunnel can start but never connect.
const PROTOCOL = process.env["TUNNEL_PROTOCOL"] ?? "http2";

const children: ChildProcess[] = [];
process.on("SIGINT", () => {
  for (const child of children) child.kill();
  process.exit(0);
});

function open(target: string, metricsPort: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "cloudflared",
      [
        "tunnel",
        "--no-autoupdate",
        "--protocol",
        PROTOCOL,
        "--metrics",
        `127.0.0.1:${String(metricsPort)}`,
        "--url",
        target,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(child);
    let host: string | undefined;
    const onData = (chunk: Buffer) => {
      const match = /https:\/\/([a-z0-9-]+\.trycloudflare\.com)/.exec(chunk.toString());
      if (match?.[1]) host = match[1];
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", reject);
    child.on("exit", (code) => {
      reject(new Error(`cloudflared for ${target} exited (${String(code)})`));
    });

    const started = Date.now();
    const poll = setInterval(() => {
      void (async () => {
        if (Date.now() - started > 60_000) {
          clearInterval(poll);
          reject(new Error(`the tunnel for ${target} did not connect within 60 s`));
          return;
        }
        if (!host) return;
        try {
          const ready = await fetch(`http://127.0.0.1:${String(metricsPort)}/ready`);
          if (ready.ok) {
            clearInterval(poll);
            resolve(host);
          }
        } catch {
          // not listening yet
        }
      })();
    }, 1000);
  });
}

function setEnv(values: Record<string, string>): void {
  const lines = readFileSync(ENV_FILE, "utf8").split(/\r?\n/);
  const eol = readFileSync(ENV_FILE, "utf8").includes("\r\n") ? "\r\n" : "\n";
  for (const [key, value] of Object.entries(values)) {
    const at = lines.findIndex((line) => line.startsWith(`${key}=`));
    if (at >= 0) lines[at] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  writeFileSync(ENV_FILE, lines.join(eol));
}

const [web, api] = await Promise.all([
  open("http://localhost:3000", 20251),
  open("http://localhost:4000", 20252),
]);

setEnv({
  WEB_URL: `https://${web}`,
  CORS_ORIGINS: `https://${web}`,
  PASSKEY_ORIGIN: `https://${web}`,
  PASSKEY_RP_ID: web,
  TELEGRAM_WEBHOOK_URL: `https://${api}${WEBHOOK_PATH}`,
});
console.log(`web tunnel : https://${web}  ->  http://localhost:3000`);
console.log(`api tunnel : https://${api}  ->  http://localhost:4000`);
console.log(
  "wrote WEB_URL, CORS_ORIGINS, PASSKEY_ORIGIN, PASSKEY_RP_ID and TELEGRAM_WEBHOOK_URL to .env",
);
console.log(
  "next: (re)start the API, then `pnpm --filter @kaada/api telegram:webhook set`. Ctrl+C closes the tunnels.",
);
setInterval(() => undefined, 60_000);
