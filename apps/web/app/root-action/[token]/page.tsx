import { ApplicationShell } from "../../components/application/application-shell";
import { RootActionFlow } from "./root-action-flow";
export const metadata = {
  title: "Confirm wallet setup",
  referrer: "no-referrer" as const,
  robots: { index: false, follow: false },
};
export default async function RootActionPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <ApplicationShell label="Your approval comes first.">
      <RootActionFlow token={token} />
    </ApplicationShell>
  );
}
