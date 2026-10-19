import { SectionHeading } from "../../components/section-heading";
import { SectionWrapper } from "../../components/section-wrapper";
import { HowItWorksSteps } from "./how-it-works-steps";
import { StartWithKaada } from "./start-with-kaada";

export function HowItWorks() {
  return (
    <section
      id="how-it-works"
      aria-labelledby="how-it-works-title"
      className="bg-background py-16 sm:py-24"
    >
      <SectionWrapper className="px-6 sm:px-10">
        <SectionHeading
          sectionName="How It Works"
          title="THE FLOW STARTS WITH A MESSAGE"
          titleId="how-it-works-title"
          action={<StartWithKaada variant="primary" className="" />}
        />
        <HowItWorksSteps />
      </SectionWrapper>
    </section>
  );
}
