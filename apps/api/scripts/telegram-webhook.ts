/*
 * Connects (or disconnects) the Telegram bot to this API. Run after the API is reachable at a public HTTPS URL.
 *
 *   pnpm --filter @kaada/api telegram:webhook info
 *   pnpm --filter @kaada/api telegram:webhook set       (reads TELEGRAM_WEBHOOK_URL)
 *   pnpm --filter @kaada/api telegram:webhook delete
 *   pnpm --filter @kaada/api telegram:webhook commands   (publishes the "/" command menu; `set` does this too)
 *
 * Reads TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET from the environment (.env). It never prints either.
 * TELEGRAM_WEBHOOK_URL is only ever read here, for example https://<public-host>/api/v1/channels/telegram/webhook
 */
try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // No .env file; rely on the real environment.
}

import { commandMenu } from "../src/core/channels/commands.js";
import type { CapabilityFlags } from "../src/core/conversation/capabilities.js";
import { TelegramAdapter } from "../src/infrastructure/channels/telegram/telegram-adapter.js";

/** The same conditions the running API uses (see capabilityFlags in channels.module.ts), read from the environment. */
function flagsFromEnvironment(): CapabilityFlags {
  const wallets = process.env["WALLET_PROVIDER"] === "kernel";
  const rates = (process.env["FX_PROVIDER"] ?? "none") !== "none";
  return {
    rates,
    send: rates && wallets,
    balance: wallets,
    funding: { walletTransfer: wallets, localCurrency: false },
  };
}

const [command = "info"] = process.argv.slice(2);
const token = process.env["TELEGRAM_BOT_TOKEN"]?.trim();
const secret = process.env["TELEGRAM_WEBHOOK_SECRET"]?.trim();
if (!token || !secret) {
  console.error("Set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET in .env first.");
  process.exit(2);
}
const adapter = new TelegramAdapter({ botToken: token, webhookSecret: secret });

async function publishCommands(): Promise<void> {
  const menu = commandMenu(flagsFromEnvironment());
  await adapter.registerCommands(menu);
  console.log(`command menu: ${menu.map((entry) => `/${entry.command}`).join(" ")}`);
}

async function main(): Promise<void> {
  switch (command) {
    case "info": {
      const me = await adapter.getMe();
      const info = await adapter.getWebhookInfo();
      console.log(`bot: @${me.username ?? "(no username)"} (id ${String(me.id)})`);
      console.log(`webhook: ${info.url || "(none)"}`);
      console.log(`pending updates: ${String(info.pendingUpdateCount)}`);
      if (info.lastError) console.log(`last delivery error: ${info.lastError}`);
      return;
    }
    case "set": {
      const url = process.env["TELEGRAM_WEBHOOK_URL"]?.trim();
      if (!url || !/^https:\/\/\S+$/.test(url)) {
        console.error(
          "Set TELEGRAM_WEBHOOK_URL to a public https:// URL (Telegram refuses anything else).",
        );
        process.exit(2);
      }
      await adapter.setWebhook(url);
      console.log(`webhook set to ${url}`);
      await publishCommands();
      return;
    }
    case "commands":
      await publishCommands();
      return;
    case "delete": {
      const response = await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`, {
        method: "POST",
      });
      console.log(response.ok ? "webhook removed" : `failed (${String(response.status)})`);
      return;
    }
    default:
      console.error("usage: telegram-webhook [info|set|commands|delete]");
      process.exit(2);
  }
}

main().catch((error: unknown) => {
  // The error never contains the token (see TelegramApiError).
  console.error(error instanceof Error ? error.message : "failed");
  process.exit(1);
});
