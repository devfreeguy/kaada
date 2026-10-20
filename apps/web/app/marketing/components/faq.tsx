import { SectionHeading } from "../../components/section-heading";
import { SectionWrapper } from "../../components/section-wrapper";
import { FaqAccordion } from "./faq-accordion";
import styles from "./faq.module.css";

export function Faq() {
  return (
    <section
      id="faq"
      aria-labelledby="faq-title"
      className="bg-background py-20 text-navy sm:py-28"
    >
      <SectionWrapper className="px-6 sm:px-10">
        <div className={styles.layout}>
          <SectionHeading
            sectionName="Questions, Answered"
            title="STILL CURIOUS? HERE’S THE SHORT VERSION."
            titleId="faq-title"
          />
          <FaqAccordion />
        </div>
      </SectionWrapper>
    </section>
  );
}
