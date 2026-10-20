import {
  IconMessageCircle,
  IconSparkles,
  IconShieldCheck,
  IconRoute,
  IconCircleCheck,
} from "@tabler/icons-react";
import styles from "./real-payments.module.css";

const steps = [
  { title: "You ask", icon: IconMessageCircle },
  { title: "Kaada understands", icon: IconSparkles },
  { title: "You approve", icon: IconShieldCheck },
  { title: "Kaada routes", icon: IconRoute },
  { title: "Payment settles", icon: IconCircleCheck },
];

export function PaymentFlow() {
  return (
    <div className={styles.flow}>
      <h3>One conversation. A complete payment flow.</h3>
      <ol className={styles.steps}>
        {steps.map(({ title, icon: Icon }, index) => (
          <li key={title}>
            <span className={styles.stepIcon}>
              <Icon size={26} stroke={1.6} aria-hidden="true" />
            </span>
            <div>
              <span className={styles.stepNumber}>0{index + 1}</span>
              <p>{title}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
