import {
  Reveal,
  RevealBoundary,
  HeadingText,
  DescriptionText,
} from "../marketing/components/landing-motion";
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
    <RevealBoundary
      className={
        centered
          ? "flex flex-col items-center gap-6 text-center"
          : "flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between lg:gap-16"
      }
    >
      <div className="max-w-4xl">
        <Reveal kind="fade">
          <p className="mb-5 font-heading text-xl leading-none text-coral uppercase sm:text-2xl">
            {sectionName}
          </p>
        </Reveal>
        <h2
          id={titleId}
          className={`font-heading text-4xl leading-[1.05] uppercase sm:text-6xl lg:text-7xl ${inverse ? "text-on-dark" : "text-navy"}`}
        >
          <HeadingText text={title} />
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
            <DescriptionText
              text={description}
              className={`${centered ? "justify-center text-center" : ""} text-base leading-relaxed lg:text-lg ${inverse ? "text-on-dark/80" : "text-navy"}`}
            />
          )}
          {action}
        </div>
      )}
    </RevealBoundary>
  );
}
import type { ReactNode } from "react";
