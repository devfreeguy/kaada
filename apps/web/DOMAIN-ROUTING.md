# Web domains

Point kaada.xyz and app.kaada.xyz at the same Next.js deployment. Preserve the original Host header. www.kaada.xyz also serves marketing.

The proxy rewrites only the marketing root to /marketing internally. app.kaada.xyz retains the existing root and all existing setup, authorize, root-action, security and recovery pages. Shared components and API rewrites remain in place. /marketing is not a public URL. API requests and static assets bypass the hostname router.

Legacy application links on the marketing domain receive temporary 307 redirects to app.kaada.xyz with paths and query strings preserved, no-store and no-referrer. Unknown and preview hosts retain the application experience; localhost serves marketing at /, with existing flow paths available directly. Use app.localhost:3000 for the local application root.

Set production API WEB_URL, CORS_ORIGINS and PASSKEY_ORIGIN to https://app.kaada.xyz. Keep PASSKEY_RP_ID=kaada.xyz to retain the existing parent-domain relying-party scope. These are deployment examples, not changes to live credentials. Browser device keys or recovery state stored on kaada.xyz do not migrate to app.kaada.xyz automatically; assess existing users before rollout. Passkey and PIN flows require end-to-end verification with the deployed API and HTTPS origin.

The marketing page is deliberately a scaffold. Anton headings, DM Sans body and named brand tokens are shared globally. Existing flow-specific utility colors remain untouched.

Preset b7lSo2CvL6 was resolved using the shadcn CLI in an isolated scratch project: base-luma, neutral, Tabler icons, subtle menu accent. components.json adapts these settings to the existing shared component paths. Brand tokens and fonts override the preset. No UI primitives or preset dependencies are needed by this scaffold; install required dependencies when adding the first shadcn component. The isolated init could not complete dependency installation because the copied package references workspace catalogs. No generated template or dependency changes were copied into the application.
