import { TELEGRAM_BOT_URL } from "../../lib/site";
import { ActionLink } from "./action-button";
import { FlowSection } from "./flow-section";

export function ApplicationHome() {
  return (
    <FlowSection
      title="Your Kaada wallet"
      description="Send money and manage your wallet from Telegram."
    >
      <ActionLink href={TELEGRAM_BOT_URL}>Open Kaada in Telegram</ActionLink>
      <ActionLink href="/recovery" variant="secondary">
        Recover your wallet
      </ActionLink>
    </FlowSection>
  );
}
