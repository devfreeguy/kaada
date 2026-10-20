import { supportedCountries } from "./global-reach-countries";
import { GlobalReachCountryCard } from "./global-reach-country-card";
import styles from "./global-reach-grid.module.css";

export function GlobalReachGrid() {
  return (
    <ul className={styles.grid} aria-label="Supported countries and currencies">
      {supportedCountries.map((country) => (
        <li key={country.id}>
          <GlobalReachCountryCard country={country} />
        </li>
      ))}
    </ul>
  );
}
