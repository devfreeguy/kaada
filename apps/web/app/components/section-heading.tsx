type SectionHeadingProps = {
  sectionName: string;
  title: string;
  description?: string;
  titleId?: string;
  action?: ReactNode;
  centered?: boolean;
  inverse?: boolean;
};

export function SectionHeading({
  sectionName,
  title,
  description,
  titleId,
  action,
  centered = false,
  inverse = false,
}: SectionHeadingProps) {
  return (
    <div
      className={
        centered
          ? "flex flex-col items-center gap-6 text-center"
          : "flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between lg:gap-16"
      }
    >
      <div className="max-w-4xl">
        <p className="mb-5 font-heading text-xl leading-none text-coral uppercase sm:text-2xl">
          {sectionName}
        </p>
        <h2
          id={titleId}
          className={`font-heading text-4xl leading-[1.05] uppercase sm:text-6xl lg:text-7xl ${inverse ? "text-on-dark" : "text-navy"}`}
        >
          {title}
        </h2>
      </div>
      {(description || action) && (
        <div
          className={
            centered
              ? "flex max-w-2xl flex-col items-center gap-6"
              : "flex max-w-sm flex-col items-start gap-6 lg:shrink-0"
          }
        >
          {description && (
            <p
              className={`text-base leading-relaxed lg:text-lg ${inverse ? "text-on-dark/80" : "text-navy"}`}
            >
              {description}
            </p>
          )}
          {action}
        </div>
      )}
    </div>
  );
}
import type { ReactNode } from "react";
