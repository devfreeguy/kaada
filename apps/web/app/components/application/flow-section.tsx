import type { ReactNode } from "react";

/** One screen of a flow: a title, at most one line of context, then the task. */
export function FlowSection({
  title,
  description,
  as: Heading = "h1",
  children,
}: {
  title: string;
  description?: ReactNode;
  as?: "h1" | "h2";
  children?: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Heading>{title}</Heading>
        {description ? <p className="text-sm text-app-muted">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}
