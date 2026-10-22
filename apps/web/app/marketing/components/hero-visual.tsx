import { Reveal } from "./landing-motion";
import Image from "next/image";
import chatMockup from "../../../assets/mockups/telegram-bot-chat-hero-mockup.webp";
import { SectionWrapper } from "../../components/section-wrapper";
import { HeroCurrencyOverview } from "./hero-currency-overview";
import { HeroStatistics } from "./hero-statistics";

export function HeroVisual() {
  return (
    <SectionWrapper className="grid items-start px-6 sm:px-10 xl:grid-cols-[minmax(0,1fr)_minmax(0,480px)_minmax(0,1fr)] xl:gap-8">
      <HeroCurrencyOverview />
      <HeroStatistics />
      <Reveal className="order-3 w-full max-w-[480px] justify-self-center xl:order-2">
        <Image
          src={chatMockup}
          alt="Kaada Bot payment conversation in Telegram"
          className="block h-auto w-full"
          sizes="(max-width: 527px) calc(100vw - 48px), 480px"
        />
      </Reveal>
    </SectionWrapper>
  );
}
