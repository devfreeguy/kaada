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
          description="Send money from Telegram today. No new app to learn. WhatsApp is coming next."
        />
        <div className={styles.cards}>
          <ChannelCard
            name="Telegram"
            status="Live now"
            live
            description="Send money, check your balance and ask how much your money is worth in another currency. All in one chat."
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
            description="Soon, you’ll be able to send money and check your balance in WhatsApp too."
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
