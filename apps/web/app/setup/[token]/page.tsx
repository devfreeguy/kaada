import { ApplicationShell } from "../../components/application/application-shell";
import { SetupFlow } from "./setup-flow";
export const metadata = {
  title: "Set up your Kaada wallet",
  referrer: "no-referrer" as const,
  robots: { index: false, follow: false },
};
export default async function SetupPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <ApplicationShell label="Make it yours.">
      <SetupFlow token={token} />
    </ApplicationShell>
  );
}
