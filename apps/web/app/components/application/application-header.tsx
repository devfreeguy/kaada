import { SITE_URL } from "../../lib/site";
import { Logo } from "../logo";
import { SectionWrapper } from "../section-wrapper";
export function ApplicationHeader() {
  return (
    <header>
      <SectionWrapper className="flex items-center justify-between gap-4 px-6 py-7 sm:px-10">
        <a href={SITE_URL} aria-label="Kaada home">
          <Logo inverted />
        </a>
        <span className="flex items-center gap-2 text-xs font-bold tracking-widest uppercase text-white/70">
          <svg aria-hidden="true" width="15" height="18" viewBox="0 0 20 24" fill="none">
            <path
              d="M10 2 2 5v6c0 5 8 11 8 11s8-6 8-11V5l-8-3Z"
              stroke="currentColor"
              strokeWidth="1.6"
            />
            <path d="m6 11 3 3 5-6" stroke="currentColor" strokeWidth="1.6" />
          </svg>
          Secure space
        </span>
      </SectionWrapper>
    </header>
  );
}
