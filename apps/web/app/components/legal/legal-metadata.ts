import type { Metadata } from "next";
import ogImage from "../../../assets/brand/og-image.jpg";
import { SITE_URL } from "../../lib/site";
import type { LegalDocumentContent } from "./legal-types";

export function legalMetadata(document: LegalDocumentContent): Metadata {
  const title = `${document.title} | Kaada`;
  return {
    title,
    description: document.description,
    alternates: { canonical: `${SITE_URL}${document.path}` },
    openGraph: {
      title,
      description: document.description,
      url: `${SITE_URL}${document.path}`,
      siteName: "Kaada",
      type: "website",
      images: [{ url: ogImage.src, width: ogImage.width, height: ogImage.height, alt: "Kaada" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: document.description,
      images: [ogImage.src],
    },
  };
}
