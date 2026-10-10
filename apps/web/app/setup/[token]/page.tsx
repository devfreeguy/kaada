import { SetupFlow } from "./setup-flow";

export const metadata = { title: "Set up your Kaada wallet", robots: { index: false } };

export default async function SetupPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <SetupFlow token={token} />;
}
