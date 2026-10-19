import { ApplicationShell } from "../../components/application/application-shell";
import { CancelFlow } from "./cancel-flow";
export const metadata = {
  title: "Stop a Kaada wallet recovery",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
export default function CancelPage() {
  return (
    <ApplicationShell label="Keep your wallet yours.">
      <CancelFlow />
    </ApplicationShell>
  );
}
