import { RevealBoundary, Reveal, HeadingText, DescriptionText } from "./landing-motion";
import { SectionWrapper } from "../../components/section-wrapper";
import Image from "next/image";
import manPointing from "../../../assets/stock-images/man-pointing.webp";
import { IconMessageCircle, IconCheck } from "@tabler/icons-react";
import {
  CrownParticle,
  PlusParticle,
  SparkleParticle,
  StarParticle,
} from "../../components/particles/particle";
import { CornerCutout } from "../../components/ui/cutout-card";
import { StartWithKaada } from "./start-with-kaada";
import styles from "./final-cta.module.css";

export function FinalCta() {
  return (
    <section
      aria-labelledby="final-cta-title"
      className="bg-background px-6 pb-10 pt-6 sm:px-10 sm:pb-16"
    >
      <SectionWrapper>
        <RevealBoundary className={styles.panel ?? ""}>
          <svg className={styles.notch} viewBox="0 0 120 52" aria-hidden="true" focusable="false">
            <path d="M0 -2H120V0C87 0 60 20 60 52C60 20 33 0 0 0Z" fill="var(--background)" />
          </svg>
          <svg
            className={styles.leftCutout}
            viewBox="0 0 44 100"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M-2-2H0L40 40C16 36 0 48 0 68V102H-2Z" fill="var(--background)" />
          </svg>
          <svg
            className={styles.rightCutout}
            viewBox="0 0 44 100"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M-2-2H0L40 40C16 36 0 48 0 68V102H-2Z" fill="var(--background)" />
          </svg>
          <CornerCutout
            corner="bottom-right"
            offset="18%"
            color="var(--background)"
            size="clamp(30px, 5vw, 64px)"
          />
          <div className={styles.content}>
            <h2 id="final-cta-title" className={styles.title}>
              <span className={styles.firstLine}>
                <CrownParticle color="var(--lime)" size="0.4em" className={styles.crown ?? ""} />
                <HeadingText text="READY WHEN" />
                <span className={styles.inlinePortrait}>
                  <Reveal kind="pop" delay={0.18} className="h-full">
                    <Image
                      src={manPointing}
                      alt=""
                      sizes="(min-width: 1354px) 159px, (min-width: 493px) 12vw, 58px"
                      className={styles.portrait}
                    />
                    <PlusParticle
                      color="var(--emerald)"
                      size="0.35em"
                      animation="horizontal"
                      duration={10}
                      distance={24}
                      delay={-9}
                      className="absolute bottom-0 left-1/2 z-10 -translate-x-1/2 translate-y-1/2"
                    />
                  </Reveal>
                </span>
              </span>
              <span className={styles.accent}>
                <HeadingText text="YOU ARE." />
              </span>
            </h2>
            <DescriptionText
              className={`${styles.description ?? ""} justify-center`}
              text="Open Kaada, send a message, and start from there."
            />
            <StartWithKaada variant="secondary" className="" />
          </div>
          <span className={styles.tag} aria-hidden="true">
            One message away
          </span>
          <span className={styles.messageBadge} aria-hidden="true">
            <IconMessageCircle size={18} stroke={1.8} />
            Send ₦20,000 to Daniel.
          </span>
          <span className={styles.sentBadge} aria-hidden="true">
            <IconCheck size={18} stroke={2} />
            Payment sent
          </span>
          <StarParticle
            color="var(--primary)"
            size="clamp(32px, 4vw, 52px)"
            animation="vertical"
            duration={8}
            distance={8}
            className={styles.star ?? ""}
          />
          <PlusParticle
            color="var(--orange)"
            size="clamp(28px, 3vw, 42px)"
            animation="horizontal"
            duration={10}
            distance={10}
            className={styles.plus ?? ""}
          />
          <SparkleParticle
            color="var(--orange)"
            size="clamp(24px, 4vw, 50px)"
            animation="spin"
            duration={60}
            delay={-12}
            className={styles.sparkle ?? ""}
          />
          <PlusParticle
            color="var(--emerald)"
            size="clamp(26px, 3vw, 40px)"
            animation="vertical"
            duration={12}
            delay={-5}
            distance={8}
            className={styles.bottomPlus ?? ""}
          />
          <StarParticle
            color="var(--coral)"
            size="clamp(24px, 3vw, 38px)"
            animation="vertical"
            duration={10}
            delay={-3}
            distance={6}
            className={styles.sideStar ?? ""}
          />
        </RevealBoundary>
      </SectionWrapper>
    </section>
  );
}
