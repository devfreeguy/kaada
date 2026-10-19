import { ApplicationShell } from "../components/application/application-shell";
import { RecoveryFlow } from "./recovery-flow";
export const metadata = {
  title: "Recover your Kaada wallet",
  referrer: "no-referrer" as const,
  robots: { index: false, follow: false },
};
export default function RecoveryPage() {
  return (
    <ApplicationShell label="Find your way back.">
      <RecoveryFlow />
    </ApplicationShell>
  );
}
