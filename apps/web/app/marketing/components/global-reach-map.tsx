"use client";
import { useId, useState, type CSSProperties } from "react";
import { ComposableMap, Geographies, Geography, Marker } from "react-simple-maps";
import { GlobalReachConnections } from "./global-reach-connections";
import { supportedCountries } from "./global-reach-countries";
import styles from "./global-reach-map.module.css";

const supportedIds = new Set(supportedCountries.map((country) => country.id));
const projectionConfig = { scale: 220, center: [0, 0] as [number, number] };

export function GlobalReachMap() {
  const [active, setActive] = useState<string | null>(null);
  const tooltipId = useId();
  const selected = supportedCountries.find((country) => country.id === active);
  return (
    <div className={styles.map} aria-label="Kaada's supported countries and currencies">
      <div
        className={styles.viewport}
        role="region"
        aria-label="Explore supported countries"
        tabIndex={0}
      >
        <ComposableMap
          width={1200}
          height={650}
          projection="geoEqualEarth"
          projectionConfig={projectionConfig}
          className={styles.world ?? ""}
          role="group"
          aria-label="World map of supported markets"
        >
          <Geographies geography="/maps/countries-110m.json">
            {({ geographies }) =>
              geographies
                .filter((geo) => geo.id !== "010")
                .map((geo) => (
                  <Geography
                    key={geo.rsmKey}
                    geography={geo}
                    tabIndex={-1}
                    className={
                      supportedIds.has(String(geo.id).padStart(3, "0"))
                        ? (styles.supportedLand ?? "")
                        : (styles.land ?? "")
                    }
                    strokeWidth={0.6}
                  />
                ))
            }
          </Geographies>
          <GlobalReachConnections />
          {supportedCountries.map((country, index) => (
            <Marker
              key={country.id}
              coordinates={country.coordinates}
              className={styles.marker ?? ""}
              role="button"
              tabIndex={0}
              aria-label={`${country.country}, ${country.currency}, ${country.symbol} ${country.code}`}
              aria-describedby={active === country.id ? tooltipId : undefined}
              aria-expanded={active === country.id}
              onMouseEnter={() => setActive(country.id)}
              onMouseLeave={(event) => {
                if (document.activeElement !== event.currentTarget) setActive(null);
              }}
              onFocus={() => setActive(country.id)}
              onBlur={() => setActive(null)}
              onClick={() => setActive(country.id)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setActive(null);
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setActive(country.id);
                }
              }}
            >
              <title>{`${country.country}, ${country.currency}`}</title>
              <circle r={Math.max(24, country.coinSize / 2 + 4)} className={styles.focusRing} />
              <g
                className={styles.float}
                style={{ animationDelay: `${index * -1.7}s` } as CSSProperties}
              >
                <image
                  href={country.coin.src}
                  x={-Math.min(64, Math.max(24, country.coinSize)) / 2}
                  y={-Math.min(64, Math.max(24, country.coinSize)) / 2}
                  width={Math.min(64, Math.max(24, country.coinSize))}
                  height={Math.min(64, Math.max(24, country.coinSize))}
                  preserveAspectRatio="xMidYMid meet"
                  className={styles.coin}
                  aria-hidden="true"
                />
              </g>
            </Marker>
          ))}
        </ComposableMap>
      </div>
      <p className={styles.swipeHint}>Swipe to explore all 9 countries</p>
      {selected && (
        <div id={tooltipId} role="tooltip" className={styles.tooltip}>
          <strong>{selected.country}</strong>
          <span>{selected.currency}</span>
          <span className={styles.currency}>
            {selected.symbol} · {selected.code}
          </span>
        </div>
      )}
      <p className="sr-only">
        Supported markets:{" "}
        {supportedCountries.map((country) => `${country.country} (${country.code})`).join(", ")}.
      </p>
    </div>
  );
}
