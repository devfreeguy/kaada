type SectionHeadingProps = {
  sectionName: string;
  title: string;
  description?: string;
  titleId?: string;
  action?: ReactNode;
};

export function SectionHeading({
  sectionName,
  title,
  description,
  titleId,
  action,
}: SectionHeadingProps) {
  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between lg:gap-16">
      <div className="max-w-4xl">
        <p className="mb-5 font-heading text-xl leading-none text-coral uppercase sm:text-2xl">
          {sectionName}
        </p>
        <h2
          id={titleId}
          className="font-heading text-4xl leading-[1.05] text-navy uppercase sm:text-6xl lg:text-7xl"
        >
          {title}
        </h2>
      </div>
      {(description || action) && (
        <div className="flex max-w-sm flex-col items-start gap-6 lg:shrink-0">
          {description && (
            <p className="text-base leading-relaxed text-navy lg:text-lg">{description}</p>
          )}
          {action}
        </div>
      )}
    </div>
  );
}
import type { ReactNode } from "react";
