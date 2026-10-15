import { availableFundingMethods } from "../conversation/capabilities.js";
import type { CapabilityFlags } from "../conversation/capabilities.js";

/**
 * The slash commands Kaada offers. They are shortcuts to things people can also just ask for in words: natural typing stays the
 * main way to use Kaada ("Send Daniel $20" has no command on purpose). A command appears only when the feature behind it really
 * exists in this deployment, and each one resolves to the same channel-neutral action as its button or its sentence.
 *
 * Not offered, because the feature does not exist yet: a transaction history, a payment status lookup.
 */
export interface CommandSpec {
  command: string;
  description: string;
}

export function commandMenu(flags: CapabilityFlags): CommandSpec[] {
  const menu: CommandSpec[] = [
    { command: "start", description: "Start, or pick up where you left off" },
  ];
  menu.push({ command: "help", description: "What I can do" });
  if (flags.balance) menu.push({ command: "balance", description: "Check your wallet balance" });
  if (availableFundingMethods(flags).length > 0) {
    menu.push({ command: "fund", description: "How to add funds to your wallet" });
    menu.push({ command: "wallet", description: "Your wallet address" });
  }
  if (flags.rates) menu.push({ command: "rates", description: "Check today's rates" });
  menu.push({ command: "country", description: "Choose your country and default currency" });
  menu.push({ command: "cancel", description: "Cancel what we're doing" });
  return menu;
}

/** The concise "what can you do?" text, built from what is really available. */
export function helpText(flags: CapabilityFlags): string {
  const lines: string[] = ["Here's what I can do 👋", ""];
  if (flags.send) lines.push("💸 Send money. Just tell me, like “Send Daniel $20”.");
  if (flags.rates) lines.push("💱 Check today's rates.");
  if (flags.balance) lines.push("👛 Show your balance.");
  if (availableFundingMethods(flags).length > 0) lines.push("💰 Help you fund your wallet.");
  const commands = commandMenu(flags)
    .filter((entry) => entry.command !== "start" && entry.command !== "help")
    .map((entry) => `/${entry.command}`);
  lines.push("", `Shortcuts: ${commands.join(" ")}`);
  return lines.join("\n");
}
