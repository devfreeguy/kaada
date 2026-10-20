import { LegalDocument } from "../../components/legal/legal-document";
import { legalMetadata } from "../../components/legal/legal-metadata";
import { termsDocument } from "../../components/legal/terms-content";

export const metadata = legalMetadata(termsDocument);

export default function Page() {
  return <LegalDocument document={termsDocument} />;
}
