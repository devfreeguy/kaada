import { StatusNote } from "./status-note";

export function CredentialUnavailable() {
  return (
    <StatusNote tone="warning">
      This browser can’t use a passkey or device key. Open the link in Safari or Chrome.
    </StatusNote>
  );
}
