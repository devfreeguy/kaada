import { AuthorizeFlow } from "./authorize-flow";

export const metadata = { title: "Authorize payment", robots: { index: false } };

export default async function AuthorizePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <AuthorizeFlow token={token} />;
}
