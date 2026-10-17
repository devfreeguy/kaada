import { CancelFlow } from "./cancel-flow";

export const metadata = {
  title: "Stop a Kaada wallet recovery",
  robots: { index: false },
  referrer: "no-referrer",
};

export default function CancelPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 px-6 py-10">
      <p className="text-sm font-semibold tracking-wide text-neutral-500">Kaada</p>
      <CancelFlow />
    </main>
  );
}
