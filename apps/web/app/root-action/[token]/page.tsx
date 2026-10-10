import { RootActionFlow } from "./root-action-flow";

export const metadata = { title: "Confirm wallet setup", robots: { index: false } };

export default async function RootActionPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <RootActionFlow token={token} />;
}
