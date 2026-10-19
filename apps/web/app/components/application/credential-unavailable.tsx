export function CredentialUnavailable() {
  return (
    <p
      role="status"
      className="rounded-2xl border border-orange/30 bg-orange/10 p-4 text-sm text-white"
    >
      This browser cannot use a passkey or keep a device key. Open this link in a supported browser
      such as Safari or Chrome on a secure connection.
    </p>
  );
}
