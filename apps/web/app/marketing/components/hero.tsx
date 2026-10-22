import { HeroText } from "./hero-text";
import entrance from "./hero-entrance.module.css";
import { SectionWrapper } from "../../components/section-wrapper";
import { StartWithKaada } from "./start-with-kaada";
import { HeroVisual } from "./hero-visual";
import {
  CrownParticle,
  PlusParticle,
  SparkleParticle,
  StarParticle,
} from "../../components/particles/particle";

export function Hero() {
  return (
    <section
      id="home"
      className="relative flex min-h-dvh flex-col overflow-hidden bg-navy text-on-dark"
    >
      <SectionWrapper className="flex min-h-[78dvh] flex-col items-center justify-center gap-6 px-6 pb-10 pt-32 text-center sm:px-10 sm:pb-12 sm:pt-36 lg:min-h-[80dvh]">
        <div className="relative isolate mb-4 w-full max-w-6xl">
          <h1 className="relative max-w-6xl font-heading text-5xl leading-[1.05] sm:text-7xl lg:text-8xl">
            <HeroText text="MOVING" />{" "}
            <span className="relative inline-block">
              <SparkleParticle
                color="var(--lavender)"
                size="0.35em"
                animation="spin"
                duration={48}
                delay={-16}
                className="absolute top-[-0.12em] left-1/2 -translate-x-1/2"
              />
              <HeroText text="MONEY" order={1} />
            </span>
            <br />
            <span className="text-primary">
              <span className="relative inline-block">
                <StarParticle
                  color="var(--lime)"
                  size="0.5em"
                  animation="spin"
                  className="absolute top-[-0.25em] -left-0.45 z-10"
                />
                <HeroText text="A" order={2} />
              </span>
              <HeroText text="CROSS BORDERS" order={2} />
            </span>{" "}
            <span className="relative inline-block h-[1.05em] w-[2.1em] align-middle">
              <span className={entrance.portrait}>
                <Image
                  src={womanSatisfied}
                  alt=""
                  className="h-full w-full rounded-full object-cover"
                  sizes="202px"
                  loading="eager"
                  fetchPriority="high"
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
              </span>
            </span>{" "}
            <span className="text-orange">
              <HeroText text="SHOULD" order={4} />
            </span>
            <br />
            <span className="relative inline-block">
              <CrownParticle
                color="var(--orange)"
                size="0.52em"
                className="absolute bottom-[0.9em] left-1/2 z-10 -translate-x-1/2"
              />
              <HeroText text="F" order={5} />
            </span>
            <HeroText text="EEL THIS" order={5} />{" "}
            <span className="inline-block whitespace-nowrap">
              <HeroText text="SIMPL" order={7} />
              <span className="relative inline-block">
                <HeroText text="E" order={7} />
                <StarParticle
                  color="var(--primary)"
                  animation="spin"
                  size="0.45em"
                  className="absolute right-0 bottom-[0.12em] z-10 translate-x-1/2 translate-y-1/2"
                />
              </span>
            </span>
          </h1>
        </div>
        <p
          className={`${entrance.description} max-w-2xl text-lg leading-relaxed sm:text-xl opacity-80`}
        >
          Send money to another country in the currencies you know. Just tell Kaada what you want to
          do in chat.
        </p>
        <StartWithKaada entrance="hero" />
      </SectionWrapper>
      <HeroVisual />
      {/* <BottomCutout /> */}
    </section>
  );
}
import Image from "next/image";
import womanSatisfied from "../../../assets/stock-images/woman-satisfied-with-kaada.webp";
