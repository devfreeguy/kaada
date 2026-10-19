import type { Metadata } from "next";
import { Anton, DM_Sans } from "next/font/google";
import type { ReactNode } from "react";

import "./globals.css";

const heading = Anton({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-anton",
  display: "swap",
});
const body = DM_Sans({ subsets: ["latin"], variable: "--font-dm-sans", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL("https://kaada.xyz"),
  title: "Kaada",
  description: "Agentic cross-border payment router on Celo.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        className={`${heading.variable} ${body.variable} min-h-screen bg-background font-sans text-foreground antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
