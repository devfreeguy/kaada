import Link from "next/link";
import { SectionWrapper } from "../section-wrapper";
import { LegalSupport } from "./legal-support";
import {
  LEGAL_DOCUMENT_DATE,
  LEGAL_DOCUMENT_DATE_LABEL,
  type LegalDocumentContent,
} from "./legal-types";
import styles from "./legal.module.css";

const documents = [
  { href: "/privacy", label: "Privacy Policy" },
  { href: "/terms", label: "Terms of Service" },
  { href: "/risk", label: "Risk Disclosure" },
];

export function LegalDocument({ document }: { document: LegalDocumentContent }) {
  return (
    <>
      <section className={styles.hero} aria-labelledby="legal-title">
        <SectionWrapper className="px-6 sm:px-10">
          <h1 id="legal-title">{document.title}</h1>
          <p className={styles.intro}>{document.intro}</p>
          <dl className={styles.dates}>
            <div>
              <dt>Effective date</dt>
              <dd>
                <time dateTime={LEGAL_DOCUMENT_DATE}>{LEGAL_DOCUMENT_DATE_LABEL}</time>
              </dd>
            </div>
            <div>
              <dt>Last updated</dt>
              <dd>
                <time dateTime={LEGAL_DOCUMENT_DATE}>{LEGAL_DOCUMENT_DATE_LABEL}</time>
              </dd>
            </div>
          </dl>
        </SectionWrapper>
      </section>
      <section className={styles.body} aria-label={`${document.title} contents`}>
        <SectionWrapper className="px-6 sm:px-10">
          <div className={styles.layout}>
            <nav aria-label="On this page" className={styles.toc}>
              <p>On this page</p>
              <ol>
                {document.sections.map(({ id, title }) => (
                  <li key={id}>
                    <Link href={`#${id}`}>{title}</Link>
                  </li>
                ))}
                <li>
                  <Link href="#legal-help-title">Questions &amp; help</Link>
                </li>
              </ol>
            </nav>
            <div className={styles.content}>
              {document.sections.map(({ id, title, paragraphs, items }, index) => (
                <section key={id} aria-labelledby={id} className={styles.section}>
                  <h2 id={id}>
                    <span className={styles.number}>{String(index + 1).padStart(2, "0")}</span>
                    {title}
                  </h2>
                  {paragraphs.map((paragraph) => (
                    <p key={paragraph}>{paragraph}</p>
                  ))}
                  {items && (
                    <ul>
                      {items.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  )}
                </section>
              ))}
              <LegalSupport />
              <nav className={styles.related} aria-label="Related legal documents">
                <p>Read alongside this document</p>
                {documents
                  .filter(({ href }) => href !== document.path)
                  .map(({ href, label }) => (
                    <Link key={href} href={href}>
                      {label}
                    </Link>
                  ))}
              </nav>
            </div>
          </div>
        </SectionWrapper>
      </section>
    </>
  );
}
