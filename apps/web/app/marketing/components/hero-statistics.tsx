import { CutoutCard } from "../../components/ui/cutout-card";
import { CompletedPayments } from "./completed-payments";

const statistics = [
  { value: "9", label: "Supported currencies", color: "var(--emerald)" },
  { value: <CompletedPayments />, label: "Payments completed", color: "var(--lime)" },
];

export function HeroStatistics() {
  return (
    <aside
      aria-label="Kaada at a glance"
      className="order-1 grid w-full max-w-sm grid-cols-2 gap-4 self-end justify-self-center pb-12 xl:order-3 xl:justify-self-end xl:pb-16"
    >
      {statistics.map(({ value, label, color }) => (
        <CutoutCard
          key={label}
          color={color}
          style={{ color: "var(--navy)" }}
          className="flex min-h-[180px] flex-col justify-center gap-3 px-5 py-8"
        >
          <svg
            aria-hidden="true"
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="absolute top-4 right-4"
          >
            <path d="M6 18 18 6M6 6h12v12" />
          </svg>
          <p className="font-heading text-[clamp(3.5rem,6vw,5rem)] leading-none">{value}</p>
          <p className="text-xs font-semibold leading-snug uppercase sm:text-sm">{label}</p>
        </CutoutCard>
      ))}
    </aside>
  );
}
