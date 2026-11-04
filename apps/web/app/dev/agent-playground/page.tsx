import { notFound } from "next/navigation";

import { Playground } from "./playground";

/*
 * The development agent playground.
 *
 * It is a developer tool, not a Kaada feature. Two independent guards keep it out of production: this page is not rendered
 * unless the build is a development one, and the API behind it has no playground provider at all unless AGENT_PLAYGROUND is
 * on, which configuration refuses in production. Hiding a link is not one of the guards.
 */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Kaada agent playground",
  robots: { index: false, follow: false },
};

export default function Page() {
  if (process.env.NODE_ENV === "production") notFound();
  return <Playground />;
}
