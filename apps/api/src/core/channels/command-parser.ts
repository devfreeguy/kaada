import type { ChannelCommand, InboundContent } from "./types.js";

/*
 * Reading a slash command out of a line of text.
 *
 * This is not Telegram's: a slash command is how people write commands in every chat app, and the playground has to read
 * "/rates naira to argentine pesos" exactly as Telegram does or it would be testing something else. It lives here so both
 * edges share one definition, and parity is pinned by a test.
 *
 * It is syntax only. What a command MEANS is decided by ChannelMessageService, the same way for every channel.
 */

const COMMANDS: Readonly<Record<string, ChannelCommand>> = {
  start: "START",
  help: "HELP",
  balance: "BALANCE",
  fund: "FUND",
  rates: "RATES",
  wallet: "WALLET",
  country: "COUNTRY",
  cancel: "CANCEL",
};

/** The longest text Kaada reads from one message. Anything beyond is cut, never rejected. */
export const MAX_TEXT_LENGTH = 2000;

/**
 * The command a line begins with, with whatever followed it, or null when the line is ordinary text.
 *
 * Recognises "/start", "/start payload" and "/start@kaadabot". Everything after the command is returned untouched as `args`
 * ("/rates naira to argentine pesos"), to be read exactly as if it had been typed on its own. "/pay now" and "/started" are
 * not commands and stay text.
 */
export function parseChannelCommand(
  text: string,
): { command: ChannelCommand; args?: string } | null {
  const match = /^\/([A-Za-z_]+)(?:@\w+)?(?:\s|$)/.exec(text);
  const name = match?.[1]?.toLowerCase();
  const command = name === undefined ? undefined : COMMANDS[name];
  if (!command) return null;
  const args = text.slice(match?.[0]?.length ?? 0).trim();
  return { command, ...(args.length > 0 && { args: args.slice(0, MAX_TEXT_LENGTH) }) };
}

/** A line of text as inbound content: a command where it is one, otherwise the text itself. */
export function contentOfText(text: string): InboundContent {
  const command = parseChannelCommand(text);
  return command
    ? { kind: "COMMAND", ...command }
    : { kind: "TEXT", text: text.slice(0, MAX_TEXT_LENGTH) };
}
