import { ApplicationShell } from "./components/application/application-shell";
import { ApplicationHome } from "./components/application/application-home";
export const metadata = { title: "Kaada", robots: { index: false, follow: false } };
export default function HomePage() {
  return (
    <ApplicationShell>
      <ApplicationHome />
    </ApplicationShell>
  );
}
