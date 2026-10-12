import { RecoveryFlow } from "./recovery-flow";

export const metadata = { title: "Recover your Kaada wallet", robots: { index: false } };

export default function RecoveryPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 px-6 py-10">
      <p className="text-sm font-semibold tracking-wide text-neutral-500">Kaada</p>
      <RecoveryFlow />
    </main>
  );
}
