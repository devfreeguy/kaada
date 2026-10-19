import Image from "next/image";
import logo from "../../assets/brand/logo.webp";

type LogoProps = {
  inverted?: boolean;
  showWordmark?: boolean;
  className?: string;
};

export function Logo({ inverted = false, showWordmark = true, className = "" }: LogoProps) {
  return (
    <span
      role="img"
      aria-label="Kaada"
      className={`inline-flex shrink-0 items-center gap-[0.1em] text-[26px] sm:text-[36px] ${inverted ? "text-on-dark" : "text-navy"} ${className}`}
    >
      <Image src={logo} alt="" width={64} height={64} className="size-[1.32em] object-contain" />
      {showWordmark && (
        <span aria-hidden="true" className="font-heading text-[0.96em] leading-none tracking-normal">
          Kaada
        </span>
      )}
    </span>
  );
}
