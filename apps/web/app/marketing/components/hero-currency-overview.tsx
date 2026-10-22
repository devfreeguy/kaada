import { RevealBoundary, Reveal, DescriptionText } from "./landing-motion";
import styles from "./hero-currency-overview.module.css";

export function HeroCurrencyOverview() {
  return (
    <RevealBoundary
      as="aside"
      className="order-2 w-full max-w-sm self-end justify-self-center pb-12 xl:order-none xl:justify-self-start xl:pb-16"
    >
      <ul className={styles.pills} aria-label="Kaada payment benefits">
        <li className={`${styles.pill} ${styles.plain}`}>
          <Reveal kind="pop" delay={0.0}>
            Just Send a Message
          </Reveal>
        </li>
        <li className={`${styles.pill} ${styles.local}`}>
          <Reveal kind="pop" delay={0.12}>
            Familiar Currencies
          </Reveal>
        </li>
        <li className={`${styles.pill} ${styles.crossBorder}`}>
          <Reveal kind="pop" delay={0.24}>
            Send Across Borders
          </Reveal>
        </li>
      </ul>
      <p className="text-center text-xl font-medium leading-snug text-on-dark uppercase sm:text-2xl xl:text-left">
        <DescriptionText
          tag="span"
          text="SEND MONEY IN 9 CURRENCIES ACROSS AFRICA, LATIN AMERICA AND BEYOND."
        />{" "}
        <DescriptionText
          tag="span"
          className="text-on-dark/55"
          text="SAME SIMPLE CHAT, WHEREVER YOUR MONEY IS GOING."
        />
      </p>
    </RevealBoundary>
  );
}
