import { ApplicationShell } from "../../components/application/application-shell";
import { AuthorizeFlow } from "./authorize-flow";
export const metadata = {
  title: "Authorize payment",
  referrer: "no-referrer" as const,
  robots: { index: false, follow: false },
};
export default async function AuthorizePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <ApplicationShell label="You approve. We handle the rest.">
      <AuthorizeFlow token={token} />
    </ApplicationShell>
  );
}
