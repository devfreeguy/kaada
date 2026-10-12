import { appendFileSync } from "node:fs";

import type {
  ChannelMessage,
  ChannelMessenger,
  IdentityType,
  RecoveryEmailSender,
} from "@kaada/domain";

/**
 * DEVELOPMENT AND TEST ONLY: writes every email as one JSON line to a file instead of sending it, so a local run or the
 * Sepolia harness can read the code. It is refused in production by the configuration. The file path is an operator
 * setting and the lines are never logged.
 */
export class FileOutboxEmailSender implements RecoveryEmailSender {
  constructor(private readonly path: string) {}

  send(input: { to: string; subject: string; text: string }): Promise<void> {
    appendFileSync(this.path, `${JSON.stringify({ at: new Date().toISOString(), ...input })}\n`, {
      mode: 0o600,
    });
    return Promise.resolve();
  }
}

/** Delivers a notification to an EMAIL identity through the email sender. Other channels are not wired yet. */
export class EmailChannelMessenger implements ChannelMessenger {
  constructor(private readonly sender: RecoveryEmailSender) {}

  supports(type: IdentityType): boolean {
    return type === "EMAIL";
  }

  send(
    identity: { type: IdentityType; externalId: string },
    message: ChannelMessage,
  ): Promise<void> {
    return this.sender.send({
      to: identity.externalId,
      subject: message.subject,
      text: message.text,
    });
  }
}
