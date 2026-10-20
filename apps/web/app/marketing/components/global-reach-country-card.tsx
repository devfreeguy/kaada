import Image from "next/image";
import type { SupportedCountry } from "./global-reach-countries";
import { countryShapes } from "./global-reach-shapes";
import styles from "./global-reach-grid.module.css";

export function GlobalReachCountryCard({ country }: { country: SupportedCountry }) {
  return (
    <article className={styles.card} aria-labelledby={`country-${country.code}`}>
      <div className={styles.visual}>
        <svg viewBox="0 0 240 200" className={styles.land} aria-hidden="true">
          <path d={countryShapes[country.id]} />
        </svg>
        <Image
          src={country.coin}
          alt=""
          width={72}
          height={72}
          sizes="72px"
          draggable={false}
          className={styles.coin}
        />
      </div>
      <div className={styles.details}>
        <h3 id={`country-${country.code}`} className={styles.name}>
          {country.country}
        </h3>
        <p className={styles.currency}>{country.currency}</p>
        <p className={styles.code}>
          <span>{country.symbol}</span>
          <span aria-hidden="true">·</span>
          <span>{country.code}</span>
        </p>
      </div>
    </article>
  );
}
