import type { ReactNode } from "react";
import { CutoutCard } from "../../components/ui/cutout-card";
import styles from "./channels.module.css";

type ChannelCardProps = {
  name: string;
  status: string;
  description: string;
  live?: boolean;
  icon: ReactNode;
  visual: ReactNode;
  action: ReactNode;
};

export function ChannelCard({
  name,
  status,
  description,
  live = false,
  icon,
  visual,
  action,
}: ChannelCardProps) {
  return (
    <article aria-labelledby={`channel-${name.toLowerCase()}`}>
      <CutoutCard
        color={live ? "var(--primary)" : "var(--navy)"}
        cutoutColor="var(--background)"
        cutoutSize={48}
        className={styles.card}
      >
        <div className={styles.content} data-live={live}>
          <div className={styles.topline}>
            <span className={styles.icon} aria-hidden="true">
              {icon}
            </span>
            <span className={styles.badge}>
              {live && <span className={styles.statusDot} />}
              {status}
            </span>
          </div>
          <h3 id={`channel-${name.toLowerCase()}`} className={styles.name}>
            {name}
          </h3>
          <p className={styles.description}>{description}</p>
          <div className={styles.action}>{action}</div>
        </div>
        {visual}
      </CutoutCard>
    </article>
  );
}
