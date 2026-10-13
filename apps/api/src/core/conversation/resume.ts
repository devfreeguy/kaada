import type { ResumeInfo } from "../responses/agent-response.js";

/**
 * The line that brings someone back to the payment that is still open after a side answer. It is worded from trusted state (the
 * stored payment's display facts), never by a model: a model must not decide which payment is being resumed or what it says.
 */
export function resumeLine(resume: ResumeInfo): string {
  if (resume.operation === "SEND" && resume.amount && resume.recipient) {
    return `You were sending ${resume.amount} to ${resume.recipient}. Want to continue?`;
  }
  if (resume.operation === "CONVERT" && resume.amount) {
    return `You were converting ${resume.amount}. Want to continue?`;
  }
  return "You have a payment in progress. Want to continue?";
}
