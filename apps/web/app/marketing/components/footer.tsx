import Link from "next/link";
import { publicCommunity } from "../../lib/public-community";
import { IconBrandTelegram, IconChevronRight } from "@tabler/icons-react";
import { Logo } from "../../components/logo";
import { SectionWrapper } from "../../components/section-wrapper";
import { TELEGRAM_BOT_URL } from "../../lib/site";
import styles from "./footer.module.css";

const groups = [
  {
    label: "Product",
    links: [
      { label: "Home", href: "/#home" },
      { label: "How it works", href: "/#how-it-works" },
      { label: "Security", href: "/#security" },
      { label: "Global Reach", href: "/#currencies" },
      { label: "FAQ", href: "/#faq" },
    ],
  },
  {
    label: "Legal",
    links: [
      { label: "Privacy", href: "/privacy" },
      { label: "Terms", href: "/terms" },
      { label: "Risk Disclosure", href: "/risk" },
    ],
  },
];

export function Footer() {
  return (
    <footer className={styles.footer}>
      <SectionWrapper className="px-6 sm:px-10">
        <div className={styles.layout}>
          <div>
            <Link href="/#home" aria-label="Kaada home" className={styles.brand}>
              <Logo
                className={styles.logo ?? ""}
                imageSizes="(min-width: 1320px) 175px, (min-width: 560px) 14vw, 74px"
              />
            </Link>
            <p className={styles.description}>
              Money moves. You stay in control.
              <br />
              Across borders, in familiar currencies, right from your chat.
            </p>
            <Link href={TELEGRAM_BOT_URL} className={styles.telegram}>
              <IconBrandTelegram size={24} stroke={1.7} aria-hidden="true" />
              Open Kaada on Telegram
            </Link>
          </div>
          <div className={styles.right}>
            <div className={styles.linkGroups}>
              {groups.map(({ label, links }) => (
                <nav key={label} aria-label={`${label} links`}>
                  <h2 className={styles.groupTitle}>{label}</h2>
                  <ul className={styles.links}>
                    {links.map(({ label: text, href }) => (
                      <li key={href}>
                        <Link href={href}>
                          <span className={styles.arrow} aria-hidden="true">
                            <IconChevronRight size={18} stroke={2} />
                          </span>
                          {text}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </nav>
              ))}
              <nav id="support" aria-label="Community links">
                <h2 className={styles.groupTitle}>Community</h2>
                <ul className={styles.links}>
                  {[
                    { label: "Telegram", href: publicCommunity.telegram },
                    { label: "GitHub", href: publicCommunity.github },
                  ].map(({ label, href }) => (
                    <li key={label}>
                      {href ? (
                        <Link href={href}>
                          <span className={styles.arrow} aria-hidden="true">
                            <IconChevronRight size={18} stroke={2} />
                          </span>
                          {label}
                        </Link>
                      ) : (
                        <span className={styles.placeholder} aria-disabled="true">
                          {label}
                          <small>Coming soon</small>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </nav>
            </div>
            <p className={styles.copyright}>
              © {new Date().getFullYear()} Kaada.
              <br />
              All rights reserved.
            </p>
          </div>
        </div>
      </SectionWrapper>
    </footer>
  );
}
