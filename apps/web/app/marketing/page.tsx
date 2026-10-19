import type { Metadata } from "next";
import ogImage from "../../assets/brand/og-image.jpg";
import { Header } from "./components/header";
import { Hero } from "./components/hero";
import { HowItWorks } from "./components/how-it-works";
import { ControlSecurity } from "./components/control-security";

const title = "Kaada | Cross-border money, made conversational";
const description =
  "Move money across borders in familiar currencies, right from your chat. Start with Kaada on Telegram.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "https://kaada.xyz" },
  openGraph: {
    type: "website",
    url: "https://kaada.xyz",
    siteName: "Kaada",
    title,
    description,
    images: [
      {
        url: ogImage.src,
        width: ogImage.width,
        height: ogImage.height,
        type: "image/jpeg",
        alt: "Kaada — Cross-border money, made conversational",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: [{ url: ogImage.src, alt: "Kaada — Cross-border money, made conversational" }],
  },
};

export default function MarketingPage() {
  return (
    <main className="relative">
      <Header />
      <Hero />
      <HowItWorks />
      <ControlSecurity />
    </main>
  );
}
