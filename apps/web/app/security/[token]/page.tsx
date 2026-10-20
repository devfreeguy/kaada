import { ApplicationShell } from "../../components/application/application-shell";
import { parseSecurityAction } from "./security-actions";
import { SecurityFlow } from "./security-flow";
export const metadata = {
  title: "Kaada wallet security",
  referrer: "no-referrer" as const,
  robots: { index: false, follow: false },
};
export default async function SecurityPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ action?: string | string[] }>;
}) {
  const [{ token }, query] = await Promise.all([params, searchParams]);
  const action = parseSecurityAction(query.action);
  return (
    <ApplicationShell label="You’re always in control.">
      <SecurityFlow key={`${token}:${action ?? "menu"}`} token={token} initialAction={action} />
    </ApplicationShell>
  );
}
