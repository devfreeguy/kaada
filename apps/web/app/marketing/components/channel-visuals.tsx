import Image from "next/image";
import { IconBrandWhatsapp, IconCheck, IconMessageCircle } from "@tabler/icons-react";
import chatMockup from "../../../assets/mockups/telegram-bot-chat-hero-mockup.webp";
import styles from "./channels.module.css";

export function TelegramChannelVisual() {
  return (
    <div className={styles.telegramVisual}>
      <Image
        src={chatMockup}
        alt="A Kaada payment conversation in Telegram"
        sizes="(max-width: 639px) 260px, 320px"
        className={styles.mockup}
      />
    </div>
  );
}

export function WhatsappChannelVisual() {
  return (
    <div className={styles.whatsappVisual} aria-hidden="true">
      <div className={styles.orbit} />
      <div className={styles.whatsappMark}>
        <IconBrandWhatsapp stroke={1.4} />
      </div>
      <span className={`${styles.floatingLabel} ${styles.sendLabel}`}>
        <IconMessageCircle size={20} />
        Just say the word.
      </span>
      <span className={`${styles.floatingLabel} ${styles.readyLabel}`}>
        <IconCheck size={20} />
        Same Kaada. New chat.
      </span>
      <span className={styles.whatsappCaption}>Your next chat is on its way.</span>
    </div>
  );
}
