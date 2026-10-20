import { LegalDocument } from "../../components/legal/legal-document";
import { legalMetadata } from "../../components/legal/legal-metadata";
import { riskDocument } from "../../components/legal/risk-content";

export const metadata = legalMetadata(riskDocument);

export default function Page() {
  return <LegalDocument document={riskDocument} />;
}
