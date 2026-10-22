import Link from "next/link";
import { SlideTransition } from "../../components/animations/components/slide-transition";
import { Logo } from "../../components/logo";
import { SectionWrapper } from "../../components/section-wrapper";
import { MobileNavigation } from "./mobile-navigation";
import { navigationItems } from "./navigation-items";

export function Header({ anchorPrefix = "" }: { anchorPrefix?: string }) {
  return (
    <header className="absolute inset-x-0 top-0 z-20 bg-transparent text-on-dark">
      <SlideTransition trigger="mount" direction="down" distance={120} duration={0.75} clipEntrance>
        <SectionWrapper className="flex items-center justify-between gap-6 px-6 py-8 sm:px-10">
          <Link href="/" aria-label="Kaada home">
            <Logo inverted />
          </Link>
          <div className="flex items-center gap-2 lg:gap-6">
            <nav aria-label="Main navigation" className="hidden lg:block">
              <ul className="flex items-center gap-6 xl:gap-8">
                {navigationItems.map(({ label, href }) => (
                  <li key={href}>
                    <Link
                      href={`${anchorPrefix}${href}`}
                      className="inline-flex min-h-11 items-center text-base font-medium uppercase transition-colors hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
                    >
                      {label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
            <span title="Language switching coming soon">
              <button
                type="button"
                disabled
                aria-label="Language switching coming soon"
                className="flex size-11 cursor-not-allowed items-center justify-center rounded-full text-on-dark/65"
              >
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="9" />
                  <ellipse cx="12" cy="12" rx="4" ry="9" />
                  <path d="M3 12h18" />
                </svg>
              </button>
            </span>
            <MobileNavigation anchorPrefix={anchorPrefix} />
          </div>
        </SectionWrapper>
      </SlideTransition>
    </header>
  );
}
