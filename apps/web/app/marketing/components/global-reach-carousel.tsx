import { supportedCountries } from "./global-reach-countries";
import { GlobalReachCountryCard } from "./global-reach-country-card";
import { CountryCarousel } from "./country-carousel";

export function GlobalReachCarousel() {
  return (
    <CountryCarousel count={supportedCountries.length}>
      {supportedCountries.map((country) => (
        <li key={country.id}>
          <GlobalReachCountryCard country={country} />
        </li>
      ))}
    </CountryCarousel>
  );
}
