import { LegalDocument } from "../../components/legal/legal-document";
import { legalMetadata } from "../../components/legal/legal-metadata";
import { privacyDocument } from "../../components/legal/privacy-content";

export const metadata = legalMetadata(privacyDocument);

export default function Page() {
  return <LegalDocument document={privacyDocument} />;
}
