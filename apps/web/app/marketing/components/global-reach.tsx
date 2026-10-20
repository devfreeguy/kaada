import { SectionHeading } from "../../components/section-heading";
import { SectionWrapper } from "../../components/section-wrapper";
import { GlobalReachCarousel } from "./global-reach-carousel";

export function GlobalReach() {
  return (
    <section
      id="currencies"
      aria-labelledby="global-reach-title"
      className="bg-background py-16 sm:py-24"
    >
      <SectionWrapper className="px-6 sm:px-10">
        <SectionHeading
          centered
          sectionName="Global Reach"
          title="BUILT FOR MORE THAN ONE BORDER."
          description="Kaada supports multiple currencies across Africa, Latin America and beyond, so one account can work across different markets without changing how you interact with it."
          titleId="global-reach-title"
        />
        <GlobalReachCarousel />
      </SectionWrapper>
    </section>
  );
}
