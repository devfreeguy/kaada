import { IconBrandTelegram, IconBrandWhatsapp } from "@tabler/icons-react";
import { SectionHeading } from "../../components/section-heading";
import { SectionWrapper } from "../../components/section-wrapper";
import { Button, ButtonArrow, ButtonLink } from "../../components/ui/button";
import { TELEGRAM_BOT_URL } from "../../lib/site";
import { ChannelCard } from "./channel-card";
import { TelegramChannelVisual, WhatsappChannelVisual } from "./channel-visuals";
import styles from "./channels.module.css";

export function Channels() {
  return (
    <section
      id="channels"
      aria-labelledby="channels-title"
      className="bg-background py-16 sm:py-24"
    >
      <SectionWrapper className="px-6 sm:px-10">
        <SectionHeading
          sectionName="Where You Use Kaada"
          title="KAADA MEETS YOU WHERE YOU ALREADY CHAT."
          titleId="channels-title"
          description="Start on Telegram today and manage payments without learning a new interface. More channels are coming as Kaada grows."
        />
        <div className={styles.cards}>
          <ChannelCard
            name="Telegram"
            status="Live now"
            live
            description="Send money, check balances, ask for rates and manage payments. All in a familiar chat."
            icon={<IconBrandTelegram />}
            visual={<TelegramChannelVisual />}
            action={
              <ButtonLink href={TELEGRAM_BOT_URL} className={styles.telegramButton ?? ""}>
                Start on Telegram
                <ButtonArrow />
              </ButtonLink>
            }
          />
          <ChannelCard
            name="WhatsApp"
            status="Coming next"
            description="The same Kaada experience, inside the app you already use to keep in touch. One more place to make your next move."
            icon={<IconBrandWhatsapp />}
            visual={<WhatsappChannelVisual />}
            action={
              <Button variant="secondary" disabled>
                Coming to WhatsApp
              </Button>
            }
          />
        </div>
      </SectionWrapper>
    </section>
  );
}
