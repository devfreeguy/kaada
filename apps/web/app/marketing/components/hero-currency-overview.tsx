import styles from "./hero-currency-overview.module.css";

export function HeroCurrencyOverview() {
  return (
    <aside className="order-2 w-full max-w-sm self-end justify-self-center pb-12 xl:order-none xl:justify-self-start xl:pb-16">
      <ul className={styles.pills} aria-label="Kaada payment benefits">
        <li className={`${styles.pill} ${styles.plain}`}>Just Send a Message</li>
        <li className={`${styles.pill} ${styles.local}`}>Familiar Currencies</li>
        <li className={`${styles.pill} ${styles.crossBorder}`}>Send Across Borders</li>
      </ul>
      <p className="text-center text-xl font-medium leading-snug text-on-dark uppercase sm:text-2xl xl:text-left">
        SEND MONEY IN 9 CURRENCIES ACROSS AFRICA, LATIN AMERICA AND BEYOND.{" "}
        <span className="text-on-dark/55">SAME SIMPLE CHAT, WHEREVER YOUR MONEY IS GOING.</span>
      </p>
    </aside>
  );
}
