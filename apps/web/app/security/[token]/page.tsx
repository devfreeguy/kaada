import { ApplicationShell } from "../../components/application/application-shell";
import { SecurityFlow } from "./security-flow";
export const metadata = {
  title: "Kaada wallet security",
  referrer: "no-referrer" as const,
  robots: { index: false, follow: false },
};
export default async function SecurityPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <ApplicationShell label="You’re always in control.">
      <SecurityFlow token={token} />
    </ApplicationShell>
  );
}
