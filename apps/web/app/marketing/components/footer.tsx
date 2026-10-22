import { ScrollToTop } from "../../components/scroll-to-top";
import { RevealBoundary, Reveal, RevealGroup, RevealItem, DescriptionText } from "./landing-motion";
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
    <RevealBoundary as="footer" className={styles.footer ?? ""}>
      <SectionWrapper className="px-6 sm:px-10">
        <div className={styles.layout}>
          <div>
            <Reveal kind="fade">
              <Link href="/#home" aria-label="Kaada home" className={styles.brand}>
                <Logo
                  className={styles.logo ?? ""}
                  imageSizes="(min-width: 1320px) 175px, (min-width: 560px) 14vw, 74px"
                />
              </Link>
            </Reveal>
            <DescriptionText
              className={styles.description ?? ""}
              text="Money moves. You stay in control. Across borders, in familiar currencies, right from your chat."
            />
            <Reveal delay={0.16}>
              <Link href={TELEGRAM_BOT_URL} className={styles.telegram}>
                <IconBrandTelegram size={24} stroke={1.7} aria-hidden="true" />
                Open Kaada on Telegram
              </Link>
            </Reveal>
          </div>
          <div className={styles.right}>
            <RevealGroup className={styles.linkGroups ?? ""}>
              {groups.map(({ label, links }, index) => (
                <RevealItem key={label} delay={index * 0.12}>
                  <nav aria-label={`${label} links`}>
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
                </RevealItem>
              ))}
              <RevealItem delay={0.24}>
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
              </RevealItem>
            </RevealGroup>
            <div className="flex items-end justify-between gap-6">
              <Reveal kind="fade" delay={0.25}>
                <p className={styles.copyright}>
                  © {new Date().getFullYear()} Kaada.
                  <br />
                  All rights reserved.
                </p>
              </Reveal>
              <Reveal delay={0.3}>
                <ScrollToTop />
              </Reveal>
            </div>
          </div>
        </div>
      </SectionWrapper>
    </RevealBoundary>
  );
}
