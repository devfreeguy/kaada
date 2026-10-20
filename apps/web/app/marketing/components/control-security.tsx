import { SectionHeading } from "../../components/section-heading";
import { SectionWrapper } from "../../components/section-wrapper";
import { SecurityCards } from "./security-cards";

export function ControlSecurity() {
  return (
    <section
      id="security"
      aria-labelledby="control-security-title"
      className="bg-background pt-24 pb-16 sm:pt-32 sm:pb-24 lg:pt-40"
    >
      <SectionWrapper className="px-6 sm:px-10">
        <SecurityCards
          heading={
            <SectionHeading
              sectionName="Control & Security"
              title="YOU’RE ALWAYS THE ONE IN CONTROL."
              description="Kaada gets your payment ready. You check the details and approve it before any money is sent. Your account stays under your control."
              titleId="control-security-title"
            />
          }
        />
      </SectionWrapper>
    </section>
  );
}
