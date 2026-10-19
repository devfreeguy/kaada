import styles from "./hero-currency-overview.module.css";

export function HeroCurrencyOverview() {
  return (
    <aside className="order-2 w-full max-w-sm self-end justify-self-center pb-12 xl:order-none xl:justify-self-start xl:pb-16">
      <ul className={styles.pills} aria-label="Kaada payment benefits">
        <li className={`${styles.pill} ${styles.plain}`}>Plain-Language Payments</li>
        <li className={`${styles.pill} ${styles.local}`}>Local Currency First</li>
        <li className={`${styles.pill} ${styles.crossBorder}`}>Cross-Border Ready</li>
      </ul>
      <p className="text-xl font-medium leading-snug text-on-dark uppercase sm:text-2xl">
        KAADA SUPPORTS 9 FAMILIAR CURRENCIES ACROSS AFRICA, LATIN AMERICA AND BEYOND,{" "}
        <span className="text-on-dark/55">MAKING CROSS-BORDER MONEY MOVEMENT FEEL LOCAL.</span>
      </p>
    </aside>
  );
}
