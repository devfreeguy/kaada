import type { ReactNode } from "react";
import { ApplicationHeader } from "./application-header";
import { SectionWrapper } from "../section-wrapper";
import styles from "./application.module.css";
export function ApplicationShell({
  children,
  label = "Your wallet. Your control.",
}: {
  children: ReactNode;
  label?: string;
}) {
  return (
    <div className={styles.shell} data-application-shell>
      <ApplicationHeader />
      <main id="main-content" className="flex flex-1 items-center py-8 sm:py-14">
        <SectionWrapper className="px-5 sm:px-8">
          <div className={styles.frame}>
            <p className={styles.eyebrow}>{label}</p>
            <div className={styles.content}>{children}</div>
            <div className={styles.signature} aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
          </div>
        </SectionWrapper>
      </main>
      <footer className="px-6 pt-4 pb-8 text-center text-xs leading-6 text-white/60">
        Built around your control. Keep your security details private.
      </footer>
    </div>
  );
}
