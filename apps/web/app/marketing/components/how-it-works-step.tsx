import type { CSSProperties, ReactNode } from "react";
import { CutoutCard } from "../../components/ui/cutout-card";

export type HowItWorksStepProps = {
  number: number;
  title: string;
  description: string;
  color: string;
  foreground: string;
  children: ReactNode;
};

export function HowItWorksStep({
  number,
  title,
  description,
  color,
  foreground,
  children,
}: HowItWorksStepProps) {
  return (
    <li>
      <CutoutCard
        color={color}
        cutoutColor="var(--background)"
        className="flex h-full flex-col gap-6 p-7 pb-10 sm:p-8 sm:pb-10"
        style={{ color: foreground, "--chat-card-color": color } as CSSProperties}
      >
        <div>
          <p className="mb-5 text-xs font-bold tracking-[0.16em] uppercase">
            Step {String(number).padStart(2, "0")}
          </p>
          <h3 className="font-heading text-3xl leading-[1.15] uppercase sm:text-4xl">{title}</h3>
          <p className="mt-4 text-base leading-relaxed">{description}</p>
        </div>
        <div className="mt-auto flex min-h-72 flex-col justify-center pt-2 lg:min-h-80">
          {children}
        </div>
      </CutoutCard>
    </li>
  );
}
