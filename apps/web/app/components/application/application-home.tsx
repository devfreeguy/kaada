import { TELEGRAM_BOT_URL } from "../../lib/site";
import { primaryAction, secondaryAction } from "./styles";
export function ApplicationHome() {
  return (
    <section className="flex flex-col gap-5">
      <h1>
        Your money.
        <br />
        <span className="text-lavender">Your move.</span>
      </h1>
      <p className="text-white/75">
        Start a conversation with Kaada to send money, set up your wallet or manage your security.
        Your chat brings you here when your approval is needed.
      </p>
      <a href={TELEGRAM_BOT_URL} className={`${primaryAction} text-center`}>
        Open Kaada in Telegram
      </a>
      <a href="/recovery" className={`${secondaryAction} text-center`}>
        Recover your wallet
      </a>
    </section>
  );
}
