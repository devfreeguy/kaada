import { SectionHeading } from "../../components/section-heading";
import { SectionWrapper } from "../../components/section-wrapper";
import { PaymentProofCards } from "./payment-proof-cards";
import { PaymentInfrastructure } from "./payment-infrastructure";

export function RealPayments() {
  return (
    <section
      id="real-payments"
      aria-labelledby="real-payments-title"
      className="bg-background py-20 text-navy sm:py-28"
    >
      <SectionWrapper className="px-6 sm:px-10">
        <SectionHeading
          sectionName="Built for Real Payments"
          title="NOT JUST A CHATBOT. A REAL PAYMENT EXPERIENCE."
          titleId="real-payments-title"
          description="Kaada connects conversation, authorization, routing and settlement into one flow. What starts as a message can end as a real transaction."
        />
        <PaymentProofCards />
        <PaymentInfrastructure />
      </SectionWrapper>
    </section>
  );
}
