import { Reveal, HeadingText, DescriptionText } from "./landing-motion";
import { IconWorld, IconWallet, IconRoute, IconFingerprint } from "@tabler/icons-react";
import { CutoutCard } from "../../components/ui/cutout-card";
import styles from "./real-payments.module.css";

const proofs = [
  {
    title: "Real payments on Celo",
    description: "Payments happen on Celo’s live network, not a test version.",
    icon: IconWorld,
    color: "var(--lime)",
    foreground: "var(--navy)",
  },
  {
    title: "You approve. It sends.",
    description: "Your money leaves your wallet only after you approve the payment.",
    icon: IconWallet,
    color: "var(--primary)",
    foreground: "var(--on-dark)",
  },
  {
    title: "Pay in different currencies",
    description: "Kaada checks how to change your money into the currency the other person needs.",
    icon: IconRoute,
    color: "var(--orange)",
    foreground: "var(--on-dark)",
  },
  {
    title: "A record of each payment",
    description: "Each payment has a record showing it was made through Kaada.",
    icon: IconFingerprint,
    color: "var(--emerald)",
    foreground: "var(--on-dark)",
  },
];

export function PaymentProofCards() {
  return (
    <ul className={styles.proofs} aria-label="Built for real payments">
      {proofs.map(({ title, description, icon: Icon, color, foreground }, index) => (
        <li key={title}>
          <Reveal delay={index * 0.1} className="h-full">
            <CutoutCard
              color={color}
              cutoutColor="var(--background)"
              cutoutSize={40}
              className={styles.proofCard}
              style={{ color: foreground }}
            >
              <span className={styles.proofIcon}>
                <Icon size={32} stroke={1.6} aria-hidden="true" />
              </span>
              <h3>
                <HeadingText text={title} />
              </h3>
              <DescriptionText text={description} />
            </CutoutCard>
          </Reveal>
        </li>
      ))}
    </ul>
  );
}
