import type { Metadata } from "next";
import Link from "next/link";
import { ButtonArrow, ButtonLink } from "../components/ui/button";

export const metadata: Metadata = {
  title: "Kaada",
  alternates: { canonical: "https://kaada.xyz" },
};

// Landing-page scaffold: keep product copy and additional sections for the design pass.
export default function MarketingPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col px-6 py-8 sm:px-10">
      <header className="flex items-center justify-between gap-6">
        <Link href="/" className="font-heading text-3xl" aria-label="Kaada home">
          Kaada
        </Link>
        <ButtonLink href="https://app.kaada.xyz">
          Open app
          <ButtonArrow />
        </ButtonLink>
      </header>
      <section className="flex flex-1 flex-col justify-center gap-5 py-24">
        <h1 className="font-heading text-6xl sm:text-8xl">Kaada</h1>
        <p className="max-w-xl text-lg text-muted-foreground">
          Agentic cross-border payment router on Celo.
        </p>
      </section>
    </main>
  );
}
