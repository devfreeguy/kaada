import { ApplicationShell } from "../../components/application/application-shell";
import { AuthorizeFlow } from "./authorize-flow";
export const metadata = {
  title: "Confirm payment",
  referrer: "no-referrer" as const,
  robots: { index: false, follow: false },
};
export default async function AuthorizePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <ApplicationShell>
      <AuthorizeFlow key={token} token={token} />
    </ApplicationShell>
  );
}
