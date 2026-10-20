import { SecurityIcon, type SecurityFeature } from "./security-icon";
import { SecurityIllustration } from "./security-illustration";

export type SecurityCardProps = {
  feature: SecurityFeature;
  title: string;
  description: string;
  color: string;
};

export function SecurityCard({ feature, title, description, color }: SecurityCardProps) {
  return (
    <article
      className="grid w-full items-center gap-6 rounded-[28px] p-5 text-white sm:gap-8 sm:p-8 lg:grid-cols-2 lg:gap-14 lg:p-12"
      style={{ backgroundColor: color, minHeight: "var(--security-card-height)" }}
    >
      <div className="grid grid-cols-[3rem_minmax(0,1fr)] items-center gap-4 sm:flex sm:items-start sm:gap-6">
        <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl border border-current/20 bg-white/15 sm:size-16">
          <SecurityIcon feature={feature} className="size-7 sm:size-8" />
        </div>
        <div className="contents sm:block">
          <h3 className="font-heading text-[28px] leading-[1.15] uppercase sm:text-4xl lg:text-[42px]">
            {title}
          </h3>
          <p className="col-span-2 max-w-md text-base leading-relaxed text-white sm:mt-5">
            {description}
          </p>
        </div>
      </div>
      <SecurityIllustration feature={feature} />
    </article>
  );
}
