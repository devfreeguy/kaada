export type LegalSectionContent = {
  id: string;
  title: string;
  paragraphs: string[];
  items?: string[];
};

export type LegalDocumentContent = {
  path: "/privacy" | "/terms" | "/risk";
  title: string;
  description: string;
  intro: string;
  sections: LegalSectionContent[];
};

export const LEGAL_DOCUMENT_DATE = "2026-10-20";
export const LEGAL_DOCUMENT_DATE_LABEL = "20 October 2026";

// TODO(founder): Confirm the operator's legal identity, business/service address and jurisdiction.
// TODO(founder): Confirm the privacy contact process, retention schedule and international-transfer safeguards.
// TODO(founder): Review these documents for the actual launch markets and any required local disclosures.
// TODO(founder): Confirm this shared effective date against the launch date before publication.
