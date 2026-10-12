import type { ChannelMessage } from "@kaada/domain";

/*
 * The words of every recovery notification. Pure functions, so what a person is told is reviewable and tested. No message
 * ever contains a Recovery Code, an email code (apart from the challenge email) or a session token; the one link is the
 * "this was not me" link, a single-use token in the URL FRAGMENT so it never reaches a server log.
 */

const utc = (date: Date) =>
  date
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, " UTC");

function approxHours(from: Date, to: Date): string {
  const hours = Math.max(1, Math.round((to.getTime() - from.getTime()) / 3_600_000));
  return hours >= 48 ? `${Math.round(hours / 24)} days` : `${hours} hours`;
}

export function reportUrl(webUrl: string, cancelToken: string): string {
  return `${webUrl.replace(/\/$/, "")}/recovery/report#${cancelToken}`;
}

export function challengeEmail(code: string, expiresAt: Date): ChannelMessage {
  return {
    subject: "Your Kaada recovery code",
    text: [
      `Your Kaada verification code is ${code}.`,
      `It expires at ${utc(expiresAt)} and works once.`,
      "Kaada will never ask you for this code anywhere except the recovery page you opened.",
      "If you did not ask to recover your wallet, ignore this message: nothing happens without it.",
    ].join("\n"),
  };
}

export function recoveryNotConfiguredEmail(): ChannelMessage {
  return {
    subject: "Kaada wallet recovery",
    text: [
      "Someone asked to recover the Kaada wallet linked to this email, but recovery is not set up for it.",
      "If this was you, open Kaada on a device where you can still use your wallet and set up a Recovery Code first.",
      "If it was not you, no action is needed.",
    ].join("\n"),
  };
}

export function recoveryUnavailableEmail(): ChannelMessage {
  return {
    subject: "Kaada wallet recovery",
    text: [
      "A wallet recovery for this email cannot start right now (a recent recovery or too many attempts).",
      "If this was you, please try again later. If it was not you, no action is needed.",
    ].join("\n"),
  };
}

export function recoveryStartedMessage(input: {
  now: Date;
  executeAfter: Date;
  reportLink: string;
}): ChannelMessage {
  return {
    subject: "Kaada: wallet recovery requested",
    text: [
      "A recovery of your Kaada wallet was requested.",
      `It is waiting for a safety delay and will complete around ${utc(input.executeAfter)} (in about ${approxHours(input.now, input.executeAfter)}).`,
      "If this was you, you do not need to do anything.",
      "If this was NOT you, stop it now: open this link. Do not share it.",
      input.reportLink,
      "If you can still use your current device, you can also cancel from there.",
    ].join("\n"),
  };
}

export function recoveryCancelledMessage(by: "ROOT" | "ATTESTOR"): ChannelMessage {
  return {
    subject:
      by === "ROOT"
        ? "Kaada: wallet recovery cancelled"
        : "Kaada: wallet recovery stopped by security",
    text:
      by === "ROOT"
        ? "The pending recovery of your Kaada wallet was cancelled from your current device. Nothing changed."
        : "The pending recovery of your Kaada wallet was stopped by Kaada security. Nothing changed. If you did not ask for it, your wallet is safe; consider reviewing your accounts.",
  };
}

export function recoveryCompletedMessage(now: Date): ChannelMessage {
  return {
    subject: "Kaada: wallet recovered",
    text: [
      `Your Kaada wallet was recovered on ${utc(now)}. The old device can no longer control it.`,
      "Your PIN must be set again, and you will create a new Recovery Code.",
      "If this was NOT you, contact Kaada support immediately.",
    ].join("\n"),
  };
}
