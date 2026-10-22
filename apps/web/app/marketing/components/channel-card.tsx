import { RevealBoundary, Reveal, DescriptionText } from "./landing-motion";
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
    <RevealBoundary as="article" aria-labelledby={`channel-${name.toLowerCase()}`}>
      <CutoutCard
        color={live ? "var(--primary)" : "var(--navy)"}
        cutoutColor="var(--background)"
        cutoutSize={48}
        className={styles.card}
      >
        <div className={styles.content} data-live={live}>
          <Reveal kind="fade">
            <div className={styles.topline}>
              <span className={styles.icon} aria-hidden="true">
                {icon}
              </span>
              <span className={styles.badge}>
                {live && <span className={styles.statusDot} />}
                {status}
              </span>
            </div>
          </Reveal>
          <DescriptionText
            tag="h3"
            delay={0}
            id={`channel-${name.toLowerCase()}`}
            className={styles.name ?? ""}
            text={name}
          />
          <DescriptionText className={styles.description ?? ""} text={description} />
          <Reveal delay={0.24} className={styles.action ?? ""}>
            {action}
          </Reveal>
        </div>
        <Reveal delay={0.16}>{visual}</Reveal>
      </CutoutCard>
    </RevealBoundary>
  );
}
