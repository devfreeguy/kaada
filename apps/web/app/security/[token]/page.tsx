import { SecurityFlow } from "./security-flow";

export const metadata = { title: "Kaada wallet security", robots: { index: false } };

export default async function SecurityPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 px-6 py-10">
      <p className="text-sm font-semibold tracking-wide text-neutral-500">Kaada</p>
      <SecurityFlow token={token} />
    </main>
  );
}
