import { createTransport } from "nodemailer";
import type { RecoveryEmailSender } from "@kaada/domain";

/** The one nodemailer method used, so tests can stand in. */
export interface MailTransport {
  sendMail(message: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

/**
 * Sends recovery email (codes and alerts) over SMTP. Plain text only: no tracking, no remote content, and a link in a
 * message is the only thing that can act, so nothing is hidden in HTML. TLS is required for any host that is not local:
 * `smtps://` is implicit TLS, `smtp://` must upgrade with STARTTLS or the send fails (`requireTLS`).
 */
export class SmtpEmailSender implements RecoveryEmailSender {
  private readonly transport: MailTransport;

  constructor(private readonly options: { from: string; url?: string; transport?: MailTransport }) {
    this.transport =
      options.transport ??
      createTransport(options.url ?? "", {
        requireTLS: true,
        connectionTimeout: 10_000,
        socketTimeout: 20_000,
      });
  }

  async send(input: { to: string; subject: string; text: string }): Promise<void> {
    // A recipient or subject carrying a line break would let a caller add headers: refuse, never sanitise silently.
    if (/[\r\n]/.test(input.to) || /[\r\n]/.test(input.subject)) {
      throw new Error("refusing an email with a line break in the recipient or subject");
    }
    await this.transport.sendMail({
      from: this.options.from,
      to: input.to,
      subject: input.subject,
      text: input.text,
    });
  }
}
