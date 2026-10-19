# Application pages

Application routes keep their existing URLs: `/setup/[token]`, `/authorize/[token]`,
`/root-action/[token]`, `/security/[token]`, `/recovery` and `/recovery/cancel`.
The hostname proxy continues to separate these from marketing.

- `page.tsx` files are server components. They resolve parameters and compose the
  shared `ApplicationShell` with an interactive flow.
- `components/application` owns the server-rendered header, navy layout, scoped
  typography, shared action styles and feedback components.
- Flow components render the interface; dedicated `use-*` controllers own state
  and handlers. Recovery steps each have their own component.
- Browser credentials, signing and PINs stay in interactive components. Read
  subscriptions ignore stale completions. Recovery and payment polling have
  separate modules with cleanup and bounded payment polling.
- `lib/api.ts` keeps requests same-origin and uncached, with tokens in bearer
  headers. Errors use status and known codes rather than raw backend wording.

Keep device keys stored **before** registering them with the API. Do not move PINs
or Recovery Codes into URLs, storage or logs. Recovery session persistence remains
limited to the current tab. Preserve server-selected steps and signing payloads.

Visual previews were captured against the existing development server with API
requests intercepted by local fixtures. These previews do not validate a real
passkey prompt, on-chain submission or production API configuration. Complete
those end-to-end checks with valid links on the configured application origin.
