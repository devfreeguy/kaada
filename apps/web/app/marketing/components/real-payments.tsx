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
          title="REAL PAYMENTS. RIGHT FROM YOUR CHAT."
          titleId="real-payments-title"
          description="This is more than a chat demo. Tell Kaada who to pay, check the details and approve. Kaada sends the money."
        />
        <PaymentProofCards />
        <PaymentInfrastructure />
      </SectionWrapper>
    </section>
  );
}
