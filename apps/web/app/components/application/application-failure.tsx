import { primaryAction } from "./styles";

export function ApplicationFailure({
  reference,
  reset,
}: {
  reference?: string | undefined;
  reset: () => void;
}) {
  return (
    <section className="flex flex-col gap-5">
      <h1>Let’s try that again</h1>
      <p className="text-white/75">
        Kaada couldn’t load this page. If you had already approved an action, check its status in
        your chat before starting it again.
      </p>
      {reference && (
        <p className="break-all text-xs text-white/60">Support reference: {reference}</p>
      )}
      <button type="button" onClick={reset} className={primaryAction}>
        Reload page
      </button>
    </section>
  );
}
