import { RevealGroup, RevealItem, DescriptionText } from "./landing-motion";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "../../components/ui/accordion";
import styles from "./faq.module.css";

const questions = [
  {
    question: "Do I need to understand crypto to use Kaada?",
    answer:
      "No. Just tell Kaada who you want to pay and how much. Kaada shows you the details before you approve.",
  },
  {
    question: "Can Kaada spend my money without my approval?",
    answer:
      "No. You check and approve each payment first. Kaada can only send the amount you approved to the person you chose.",
  },
  {
    question: "Which countries and currencies are supported?",
    answer:
      "You can use Nigerian naira, Brazilian real, Argentine pesos, Indonesian rupiah, Mexican pesos, Colombian pesos, Chilean pesos, Peruvian soles and US dollars. Kaada checks whether it can make your payment before asking you to approve.",
  },
  {
    question: "Where can I use Kaada today?",
    answer:
      "Kaada is live on Telegram. Open the bot, start a conversation and tell it what you want to do. WhatsApp is coming next.",
  },
  {
    question: "How do I approve a payment?",
    answer:
      "Check the payment details, then enter your six-digit payment PIN on Kaada’s secure page. Never type your PIN in chat.",
  },
  {
    question: "What happens if I lose access to my account?",
    answer:
      "If you set up recovery, you can get back in using your email, Recovery Code and a code from your authenticator app. There is also a waiting period. Keep these safe: Kaada cannot get you back in without them.",
  },
  {
    question: "Do I need CELO to make a payment?",
    answer:
      "Yes. CELO pays the small fee for sending money on the network. Your wallet needs a little of it. Kaada will tell you if you need to add more before sending.",
  },
  {
    question: "Is Kaada a bank?",
    answer:
      "No. Kaada helps you send money from your wallet through chat. Your Kaada wallet is not a bank account.",
  },
];

export function FaqAccordion() {
  return (
    <RevealGroup>
      <Accordion defaultValue={[questions[0]!.question]} className={styles.accordion}>
        {questions.map(({ question, answer }, index) => (
          <AccordionItem key={question} value={question} className={styles.item}>
            <RevealItem delay={index * 0.075}>
              <AccordionTrigger className={styles.question}>
                <span>{question}</span>
              </AccordionTrigger>
              <AccordionContent>
                <DescriptionText className={styles.answer ?? ""} text={answer} />
              </AccordionContent>
            </RevealItem>
          </AccordionItem>
        ))}
      </Accordion>
    </RevealGroup>
  );
}
