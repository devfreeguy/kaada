import type { ReactNode } from "react";
import { Header } from "../../marketing/components/header";
import { Footer } from "../../marketing/components/footer";

export function LegalPageLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative bg-background text-navy">
      <Header anchorPrefix="/" />
      <main>{children}</main>
      <Footer />
    </div>
  );
}
