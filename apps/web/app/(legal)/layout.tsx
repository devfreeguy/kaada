import type { ReactNode } from "react";
import { LegalPageLayout } from "../components/legal/legal-page-layout";

export default function LegalLayout({ children }: { children: ReactNode }) {
  return <LegalPageLayout>{children}</LegalPageLayout>;
}
