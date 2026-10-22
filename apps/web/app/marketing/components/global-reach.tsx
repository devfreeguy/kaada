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
          sectionName="Where Your Money Can Go"
          title="BUILT FOR MORE THAN ONE BORDER."
          description="Send money in 9 currencies across Africa, Latin America and beyond. You use the same Kaada chat each time."
          titleId="global-reach-title"
        />
      </SectionWrapper>
      <GlobalReachCarousel />
    </section>
  );
}
