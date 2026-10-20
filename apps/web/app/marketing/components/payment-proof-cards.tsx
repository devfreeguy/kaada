import { IconWorld, IconWallet, IconRoute, IconFingerprint } from "@tabler/icons-react";
import { CutoutCard } from "../../components/ui/cutout-card";
import styles from "./real-payments.module.css";

const proofs = [
  {
    title: "Built on Celo mainnet",
    description: "A foundation for money that moves.",
    icon: IconWorld,
    color: "var(--lime)",
  },
  {
    title: "Real wallet execution",
    description: "You approve. Your wallet takes action.",
    icon: IconWallet,
    color: "var(--primary)",
  },
  {
    title: "Real currency routes",
    description: "From what you send to what arrives.",
    icon: IconRoute,
    color: "var(--orange)",
  },
  {
    title: "Attribution built in",
    description: "A payment trail that connects back to Kaada.",
    icon: IconFingerprint,
    color: "var(--emerald)",
  },
];

export function PaymentProofCards() {
  return (
    <ul className={styles.proofs} aria-label="Built for real payments">
      {proofs.map(({ title, description, icon: Icon, color }) => (
        <li key={title}>
          <CutoutCard
            color={color}
            cutoutColor="var(--background)"
            cutoutSize={40}
            className={styles.proofCard}
          >
            <span className={styles.proofIcon}>
              <Icon size={32} stroke={1.6} aria-hidden="true" />
            </span>
            <h3>{title}</h3>
            <p>{description}</p>
          </CutoutCard>
        </li>
      ))}
    </ul>
  );
}
