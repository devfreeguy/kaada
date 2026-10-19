import Image, { type StaticImageData } from "next/image";
import { CutoutCard } from "../../components/ui/cutout-card";

export type HowItWorksStepProps = {
  number: number;
  title: string;
  description: string;
  color: string;
  foreground: string;
  screenshot?: StaticImageData;
};

export function HowItWorksStep({
  number,
  title,
  description,
  color,
  foreground,
  screenshot,
}: HowItWorksStepProps) {
  return (
    <li>
      <CutoutCard
        color={color}
        cutoutColor="var(--background)"
        className="flex h-full flex-col gap-6 p-7 pb-10 sm:p-8 sm:pb-10"
        style={{ color: foreground }}
      >
        <div>
          <p className="mb-5 text-xs font-bold tracking-[0.16em] uppercase">
            Step {String(number).padStart(2, "0")}
          </p>
          <h3 className="font-heading text-3xl leading-[1.15] uppercase sm:text-4xl">{title}</h3>
          <p className="mt-4 text-base leading-relaxed">{description}</p>
        </div>
        <div className="mt-auto flex h-64 items-end justify-center overflow-hidden lg:h-80">
          {screenshot && (
            <Image
              src={screenshot}
              alt={`Kaada payment flow: ${title}`}
              className="block h-full w-auto max-w-full object-contain object-bottom"
              sizes="(min-width: 1024px) 360px, (min-width: 640px) 560px, calc(100vw - 104px)"
            />
          )}
        </div>
      </CutoutCard>
    </li>
  );
}
