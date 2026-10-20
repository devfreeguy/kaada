import { HowItWorksStep, type HowItWorksStepProps } from "./how-it-works-step";
import { MessageStepChat } from "./message-step-chat";
import { ReviewStepChat } from "./review-step-chat";
import { PaymentStepChat } from "./payment-step-chat";

const steps: HowItWorksStepProps[] = [
  {
    number: 1,
    title: "Tell Kaada what you want to do",
    description: "“Send ₦20,000 to Daniel.”",
    color: "var(--coral)",
    foreground: "var(--on-dark)",
    children: <MessageStepChat />,
  },
  {
    number: 2,
    title: "Review the details",
    description: "Kaada works out the route, amount and recipient outcome.",
    color: "var(--emerald)",
    foreground: "var(--on-dark)",
    children: <ReviewStepChat />,
  },
  {
    number: 3,
    title: "Approve and send",
    description: "You authorize the payment, and Kaada handles the rest.",
    color: "var(--navy)",
    foreground: "var(--on-dark)",
    children: <PaymentStepChat />,
  },
];

export function HowItWorksSteps() {
  return (
    <ol className="mt-10 grid gap-5 sm:mt-14 lg:grid-cols-3 lg:gap-6">
      {steps.map((step) => (
        <HowItWorksStep key={step.number} {...step} />
      ))}
    </ol>
  );
}
