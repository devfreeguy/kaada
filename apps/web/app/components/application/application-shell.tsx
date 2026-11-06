import type { ReactNode } from "react";
import { ApplicationHeader } from "./application-header";
import { SectionWrapper } from "../section-wrapper";
import styles from "./application.module.css";

/** The frame every application screen sits in: header, then the one active task. Nothing decorative. */
export function ApplicationShell({ children }: { children: ReactNode }) {
  return (
    <div className={styles.shell} data-application-shell>
      <ApplicationHeader />
      <main id="main-content" className="flex flex-1 items-center py-6 sm:py-12">
        <SectionWrapper className="px-5 sm:px-8">
          <div className={styles.frame}>
            <div className={styles.content}>{children}</div>
          </div>
        </SectionWrapper>
      </main>
    </div>
  );
}
