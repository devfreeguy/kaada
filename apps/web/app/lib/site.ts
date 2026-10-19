/**
 * The addresses the pages link to, in one place. The Telegram bot name is public (it is in every t.me link) and can be changed
 * without a code change by setting NEXT_PUBLIC_TELEGRAM_BOT_USERNAME in the deployment's environment.
 */
const botUsername = (process.env["NEXT_PUBLIC_TELEGRAM_BOT_USERNAME"] ?? "kaadabot")
  .trim()
  .replace(/^@/, "");

/** Where "start with Kaada" sends a person. */
export const TELEGRAM_BOT_URL = `https://t.me/${botUsername}?start=landing`;

/** The public marketing site. */
export const SITE_URL = "https://kaada.xyz";

/** The secure application (setup, authorize, recovery). */
export const APP_PATH_RECOVERY = "/recovery";
