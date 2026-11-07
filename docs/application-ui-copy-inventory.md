# Kaada application: UI copy inventory

Read-only audit. Nothing in the application was changed to produce this document. The landing page (`apps/web/app/marketing/**`, served at `/` on the marketing hosts) is out of scope.

Scope: `apps/web/app/**` (the application), plus the text the Telegram bot and the API send that the application's screens or its Telegram counterpart show to the same person.

Kind column (`K`): **S** = static, app-owned string · **D** = dynamic, app-owned template (the rendered text depends on data or state) · **B** = backend/bot-owned (the API or bot decides the words; the web page only renders it, or Telegram shows it) · **E** = external or runtime-generated (model-written, provider, browser/OS dialog, user data) · **A** = accessibility-only text (aria-label, screen-reader text).

Line numbers are those of the working tree when the audit was written. "Source" is always a real file; `~` means an approximate range.

---

## 0. Assumptions

1. "Application" means every route reachable on the application host (`app.kaada.xyz`) plus the dev playground; the marketing page is excluded as requested. `/` on the application host is the application home (`ApplicationHome`), not the landing page (`proxy.ts` rewrites `/` to `/marketing` only on the marketing hosts).
2. The three legal pages (`/privacy`, `/terms`, `/risk`) are long-form legal documents served by `app/(legal)/**`. They are listed as routes, but their body text (`app/components/legal/*-content.ts`) is **not transcribed**: it is a document, not interface copy. Say so if you want it inventoried too.
3. The application has **no** transaction-history, beneficiary/contact-management, profile, or in-app "send/swap" screens. All of those happen in Telegram. The web app contains only link-driven flows (setup, authorize, root-action, security, recovery) and the home page. This was confirmed by listing every `page.tsx`. Where the brief names a flow that does not exist in the web app, it is marked "not in the web app".
4. There is no localization layer: no i18n library, no message catalogues. Every string is English and lives in code.
5. `app/lib/app-copy.ts` is the shared copy module; many screens ask it for their words by context. Other strings are inline in JSX or hooks.
6. Browser/OS-owned dialogs (the passkey sheet, the "use your fingerprint" prompt) are external and not documented beyond noting they appear.
7. Conversation text the bot sends that is written by a language model cannot be enumerated from code. Only the fixed fallback wording and the structure are inventoried (section 10).

---

## 1. Pages and routes

| # | Route | Page file | Browser tab title | Flow(s) | Reachable how |
|---|---|---|---|---|---|
| 1 | `/` (application host) | `app/page.tsx:3` | "Your Kaada wallet" | Application home | Link from Telegram/web |
| 2 | `/setup/[token]` | `app/setup/[token]/page.tsx:4` | "Set up your Kaada wallet" | Wallet setup, PIN creation, recovery setup | Bot button "Set up Kaada", "Set up PIN", "Secure my account", "Continue setup" |
| 3 | `/authorize/[token]` | `app/authorize/[token]/page.tsx:4` | "Authorize payment" | Payment/conversion authorization, payment progress, extra confirmation link | Bot button "Authorize payment" |
| 4 | `/root-action/[token]` | `app/root-action/[token]/page.tsx:4` | "Confirm" | The extra root confirmation a payment/conversion can need | Link from the authorize page, or bot button "Continue securely" |
| 5 | `/security/[token]` (+ `?action=rotate\|backup\|recovery`) | `app/security/[token]/page.tsx:5` | "Kaada wallet security" | Change passkey/device, add backup, set up recovery | Bot security link |
| 6 | `/recovery` | `app/recovery/page.tsx:4` | "Recover your Kaada wallet" | Wallet recovery | Link "Recover your wallet" from home and from the authorize page |
| 7 | `/recovery/cancel#<token>` | `app/recovery/cancel/page.tsx:4` | "Stop a Kaada wallet recovery" | Stop a recovery | Link in the recovery-started email |
| 8 | `/dev/agent-playground` | `app/dev/agent-playground/page.tsx:15` | "Kaada agent playground" | Developer chat harness | Dev only (API flag `AGENT_PLAYGROUND`) |
| 9 | `/privacy` | `app/(legal)/privacy/page.tsx` | (not read; see assumption 2) | Legal | Footer links |
| 10 | `/terms` | `app/(legal)/terms/page.tsx` | (not read) | Legal | |
| 11 | `/risk` | `app/(legal)/risk/page.tsx` | (not read) | Legal | |
| 12 | error boundary | `app/error.tsx` | n/a | Render crash | Automatic |
| 13 | global error boundary | `app/global-error.tsx` | n/a | Root layout crash | Automatic |

Not UI (no user-facing text): `app/api/[...path]/route.ts` (API proxy; returns JSON error codes the page maps itself, see section 8), `app/api/client-log/route.ts`. `/marketing` is the landing page and is excluded.

Site-wide defaults, `app/layout.tsx:19-20`: `<title>` "Kaada" (S), description "Agentic cross-border payment router on Celo." (S). `<html lang="en">` line 25.

---

## 2. Flows and their steps

| Flow | Page | Steps / states documented |
|---|---|---|
| F1 Application home | `/` | single screen |
| F2 Wallet setup | `/setup` | loading → create credential (passkey / device key) → finish → [PIN] create/confirm/saving/saved → recovery setup *or* "Wallet ready" |
| F3 PIN creation (inside setup) | `/setup` | enter → confirm → working (root proof) → saved; errors |
| F4 Recovery setup (inside setup and security) | `/setup`, `/security?action=recovery` | email → authenticator → intro → show code → confirm → arming → done; errors |
| F5 Payment / conversion authorization | `/authorize` | loading → ready (passkey / device key + PIN / PIN) → submitting → blocked (no PIN / reset) → done |
| F6 Payment progress (after authorization) | `/authorize` (done screen) | preparing → running → waiting for the extra confirmation → sent / pending / failed states |
| F7 Extra confirmation (root action) | `/root-action` | loading → ready → confirming → done; invalid; load error |
| F8 Wallet security | `/security` | menu → change credential / add backup / set up recovery → progress states |
| F9 Wallet recovery | `/recovery` | start → email code → create credential → prove factors → waiting → prove new credential → reset PIN → set up recovery again → done / stopped / failed |
| F10 Stop a recovery | `/recovery/cancel` | ready → working → stopped; invalid; error |
| F11 Error screens | any | render crash; layout crash |
| F12 Agent playground (dev) | `/dev/agent-playground` | chat + debug panel |
| F13 Telegram bot (counterpart; section 10) | Telegram | onboarding, send, convert, balance, rates, funding, payment status, recovery emails |

Counts are summarised at the end.

---

## 3. Shared components (what each says, and where it is reused)

### 3.1 `FlowSection` (`app/components/application/flow-section.tsx:1-24`)
Renders `title` (h1/h2) and an optional `description`. No text of its own. Used by every flow.

### 3.2 `FlowStatus` (`app/components/application/flow-status.tsx:11-41`) with `linkCopy` (`app/lib/app-copy.ts:147-155`)
The loading / expired / load-failed states every link-driven page shows before its content. The wording depends on `subject`.

| State | Text | Source | K |
|---|---|---|---|
| loading (all subjects) | `Loading…` (`role="status"`) | `app-copy.ts:147`, rendered `flow-status.tsx:25` | S |
| expired, subject `payment` | title `Link expired`, body `Ask Kaada in your chat for a new payment link.` | `app-copy.ts:148-151` | D |
| expired, subject `setup` | title `Link expired`, body `Ask Kaada in your chat for a new setup link.` | same | D |
| expired, subject `request` | title `Link expired`, body `Ask Kaada in your chat for a new link.` | same (special case in template) | D |
| expired, subject `security` | title `Link expired`, body `Ask Kaada in your chat for a new security options link.` | same | D |
| load-failed `payment` / `setup` / `request` / `security` | title `Couldn't load payment` / `Couldn't load setup` / `Couldn't load request` / `Couldn't load security options`; button `Try again`; optional red note with the page's message | `app-copy.ts:152-155`, `flow-status.tsx:34-39` | D |

Used with: `subject="payment"` on `/authorize`; `"setup"` on `/setup` (also the PIN step while loading); `"request"` on `/root-action` and on the recovery page (while loading and while a session is loading). `"security"` is declared but **no page passes it** (checked by search; see section 11).

### 3.3 `VerificationStep` (`app/components/application/verification-step.tsx:12-62`) with `verifyCopy` (`app/lib/app-copy.ts:~36-115`)
One screen for "prove it is you". Title, optional hint, button and busy label come from a context + method pair. Optional notice (red), summary, footer, alternative button.

| Context | Method | Title | Hint | Button | While waiting | Ending | Used by |
|---|---|---|---|---|---|---|---|
| `payment` | passkey | `Confirm payment` | – | `Confirm with passkey` | `Waiting for your passkey…` | – | `/authorize` when the wallet root is a passkey and the operation is `SEND` |
| `payment` | device | `Confirm payment` | `Enter your PIN.` | `Confirm` | `Confirming…` | – | `/authorize`, device-key wallet, `SEND` (a PIN keypad replaces the button, see 3.4) |
| `payment` | pin | `Authorize payment` | `Enter your PIN.` | `Authorize` | `Authorizing…` | – | `/authorize`, PIN-only wallet, `SEND` |
| `conversion` | passkey | `Confirm conversion` | – | `Confirm with passkey` | `Waiting for your passkey…` | – | `/authorize`, `CONVERT` |
| `conversion` | device | `Confirm conversion` | `Enter your PIN.` | `Confirm` | `Confirming…` | – | `/authorize`, `CONVERT` |
| `conversion` | pin | `Authorize conversion` | `Enter your PIN.` | `Authorize` | `Authorizing…` | – | `/authorize`, `CONVERT` |
| `wallet-setup` | passkey | `Secure your wallet` | `Use your fingerprint, face or screen lock.` | `Create passkey` | `Waiting for your device…` | – | `/setup` first step |
| `wallet-setup` | device | `Secure your wallet` | `Keep a key on this device and confirm payments with your PIN.` | `Use this device` | `Creating key…` | – | `/setup` (main action after a failed passkey attempt that offered the device; also the secondary button text) |
| `payment-root` | passkey | `Confirm payment with passkey` | (server message, see 6.2) | `Confirm with passkey` | `Waiting for your passkey…` | title `Passkey verified`, body `Your payment continues. Follow it in your chat.` | `/root-action`, `SEND` |
| `payment-root` | device | `Confirm payment on this device` | (server message) | `Confirm with this device` | `Confirming…` | title `Confirmed on this device`, body `Your payment continues. Follow it in your chat.` | `/root-action`, `SEND` |
| `conversion-root` | passkey | `Confirm conversion with passkey` | (server message) | `Confirm with passkey` | `Waiting for your passkey…` | title `Passkey verified`, body `Your conversion continues. Follow it in your chat.` | `/root-action`, `CONVERT` |
| `conversion-root` | device | `Confirm conversion on this device` | (server message) | `Confirm with this device` | `Confirming…` | title `Confirmed on this device`, body `Your conversion continues. Follow it in your chat.` | `/root-action`, `CONVERT` |

Shared vs context-specific: the button/busy words `Confirm with passkey`, `Waiting for your passkey…`, `Confirming…` repeat across contexts; titles are always context-specific. Combinations that do not exist (for example `wallet-setup` + `pin`, `payment-root` + `pin`) throw at render (`verifyCopy` line ~120) instead of showing text.

Source: `app-copy.ts` lines 38-87 (static table), 93-114 (`rootStep` template), 118-141 (context helpers, `verifiedCopy`).

### 3.4 `PinKeypad` (`app/components/pin-keypad.tsx:25-86`)
| Element | Text | Source | K |
|---|---|---|---|
| Dot indicator | `{n} of 6 digits entered` | line 40 | A / D |
| Keys | `1`-`9`, `0` | lines 19, 72 | S |
| Delete key | glyph `⌫`; aria-label `Delete` | lines 65, 70 | S / A |
| Submit key | prop `submitLabel`, default `Go` (line 30). Contexts: `Confirm` (authorize, `authorize-flow.tsx:90`); `Next`/`Save` (PIN creation, `pin-setup.tsx:45`; PIN reset, `pin-reset.tsx:17`) | | D |

### 3.5 `StatusNote` (`status-note.tsx`), `ActionButton`/`ActionLink` (`action-button.tsx`), `TextField` (`text-field.tsx`)
No text of their own. `StatusNote` renders `role="alert"` for danger/warning tones and `role="status"` otherwise (lines 14-18) (A). `ActionButton` shows `busyLabel` while busy, else its children (line 40). `TextField` renders the `label` prop always, the `hint` prop under it if given (lines 22-30).

### 3.6 `CredentialUnavailable` (`credential-unavailable.tsx:5-7`)
`This browser can’t use a passkey or device key. Open the link in Safari or Chrome.` (S, warning note). Used in: `/security` credential step (shown when capabilities are ready and neither passkey nor device key is available, `security-credential-step.tsx:23-25`) and `/recovery` credential step (`recovery-credential.tsx:19-21`).

### 3.7 `ApplicationShell` / `ApplicationHeader` (`application-header.tsx`)
| Element | Text | Source | K |
|---|---|---|---|
| Logo link | aria-label `Kaada home` | line 8 | A |
| Shield icon | `aria-hidden` (no text) | line 12 | A |
| Badge | `Secure` | line 20 | S |

### 3.8 `ApplicationFailure` (`application-failure.tsx:13-17`)
Title `Something went wrong`; description `If you approved something, check your chat before trying again.`; optional `Reference: {digest}` (D, line 16); button `Reload`. Used by `error.tsx:23`.

### 3.9 `QrCode` (`qr-code.tsx:28`)
aria-label is the `label` prop. Only caller: authenticator enrollment, label `QR code for your authenticator app` (`authenticator-enroller.tsx:32`) (A).

### 3.10 `RecoveryNeeds` (`app/components/recovery-needs.tsx`) with `app/lib/recovery-copy.ts`
| Element | Text | Source | K |
|---|---|---|---|
| Lead-in | `To recover your Kaada wallet, you'll need all three:` | `recovery-copy.ts:6` | S |
| List | `your recovery email` · `your Recovery Code` · `access to your authenticator app` | `recovery-copy.ts:8-10` | S |
| Warning | `If you lose your Recovery Code or your authenticator app, Kaada cannot restore your wallet.` | `recovery-copy.ts:13` | S |

(Which of the three is rendered by the component, and in what markup, was not traced line by line. Runtime verification.) Shown at: recovery start (`recovery-start.tsx`), recovery-setup `email`, `authenticator`, `intro` and `confirm` steps (`recovery-code-intro.tsx:20,26,32`, `recovery-code-confirmation.tsx:37`).

### 3.11 Failure copy shared by several flows (`failureCopy`, `app-copy.ts:158-178`)
| Key | Text | Used by |
|---|---|---|
| `cancelled` | `Cancelled. Nothing was changed.` | `/setup` passkey cancelled (`use-setup.ts:259`); `/root-action` cancelled (`use-root-action.ts:115`) |
| `cancelledPayment` | `Cancelled. Nothing was sent.` | `/authorize` prompt cancelled (`confirm-payment.ts:103`) |
| `deviceKeyMissing` | `This browser doesn't hold your device key. Open the link on the device you set up.` | setup PIN (`use-pin-setup.ts:95`), root-action (`use-root-action.ts:113`), security (`use-security.ts:165`), recovery (`use-recovery.ts:155`), recovery cancel (`use-cancel-recovery.ts:58`), recovery code (`use-recovery-code.ts:119`), authorize (`confirm-payment.ts:99`) |
| `unknownPayment` | `Couldn't confirm the result. Check your chat before trying again.` | `/authorize` generic failure (`confirm-payment.ts:59,105`) |
| `unknownRequest` | `Couldn't confirm the result. Check your payment before trying again.` | `/root-action` generic failure (`use-root-action.ts:116`) |
| `wrongPin(left)` | `Incorrect PIN. {n} attempt(s) left.` or `Incorrect PIN.` | `/authorize` (`confirm-payment.ts:47`) |
| `locked` | `Too many attempts. Try again later.` | `/authorize` locked without a known end |
| `lockedFor(d)` | `Too many attempts. Try again in {about a minute / N minutes}.` | `/authorize` lock banner (`authorize-flow.tsx:~76`; duration from `authorization-machine.ts` `lockLabel`) |
| `rateLimited` | `Too many attempts. Wait a moment.` | `/authorize` status 429 |
| `pinRequired` | `Enter your PIN.` | `/authorize` code `PIN_REQUIRED` |
| `insufficientBalance` | `Not enough balance for this payment and its fee. Nothing was sent.` | `/authorize` code `INSUFFICIENT_BALANCE` |
| `gasFunding` | `Your wallet needs CELO for the network fee. Nothing was sent.` | `/authorize` code `GAS_FUNDING_REQUIRED` |
| `notSent` | `The payment wasn't sent. Start it again from your chat.` | `/authorize` code `NOT_SENT` |

### 3.12 `describeError` (`app/lib/api.ts:52-80`): shared mapping from API error to words
Used wherever a hook passes a fallback. The server's own wording is never shown (`api.ts:20` comment); the page maps the machine `code`/`kind`.

| Condition | Text | K |
|---|---|---|
| code `INVALID_PIN` | `That PIN is incorrect. Please try again.` | S |
| code `PIN_LOCKED` or status 423 | `Too many wrong PIN attempts. Please try again later.` | S |
| code `PIN_NOT_SET` | `Create your payment PIN before continuing.` | S |
| code `GAS_ESTIMATE_UNAVAILABLE` | `We can't finish securing your account right now. Please try again in a few minutes.` | S |
| code `GAS_FUNDING_REQUIRED` | `To finish securing your account, add a small amount of CELO to your wallet.` | S |
| code `SPONSORSHIP_UNAVAILABLE` | `To finish securing your account, add a small amount of CELO to your wallet, or deposit a larger amount.` | S |
| code `PIN_RESET_REQUIRED` | `Your PIN needs to be reset through account recovery.` | S |
| kind `invalid` (401) | `This link or session has expired. Start again.` | S |
| kind `rate-limited` (429) | `Too many attempts. Please wait a few minutes.` | S |
| kind `unavailable` (≥500) | `Kaada is temporarily unavailable. Please try again.` | S |
| browser error `NotAllowedError` | `That was cancelled. Nothing was changed; you can try again.` | S |
| `SecurityError` | `Open this link on the Kaada address it was sent for, in a supported browser.` | S |
| `NotSupportedError` | `This device cannot create that credential. Try another supported device.` | S |
| `InvalidStateError` | `This device already has that passkey. Try a different authenticator.` | S |
| anything else (including kind `rejected`) | the caller's fallback string (listed per page below) | S |

The `/api/[...path]` proxy (`route.ts:45-51`) returns JSON with `error` (a code) and a `message`; the web never displays that message.

---

## 4. Page 1: Application home (`/`)

Component `ApplicationHome` (`app/components/application/application-home.tsx:5-16`).

| Element | Text | Source | K |
|---|---|---|---|
| Tab title | `Your Kaada wallet` | `app/page.tsx:3` | S |
| Heading | `Your Kaada wallet` | `application-home.tsx:8` | S |
| Description | `Send money and manage your wallet from Telegram.` | line 9 | S |
| Primary link | `Open Kaada in Telegram` (target `https://t.me/<bot>?start=landing`, `app/lib/site.ts:10`) | line 11 | S |
| Secondary link | `Recover your wallet` (`/recovery`) | line 13 | S |
| Header | `Kaada home` (A), `Secure` | 3.7 | |

---

## 5. Page 2: Wallet setup (`/setup/[token]`)

Controller `useSetup` (`app/setup/[token]/use-setup.ts`), screens chosen in `setup-flow.tsx:8-33`. Tab title `Set up your Kaada wallet` (`page.tsx:4`).

### Step 1: Loading / expired / load failed
| State | Text | Source | K |
|---|---|---|---|
| loading | `Loading…` | `setup-flow.tsx:11` → 3.2 | S |
| invalid link (401 on load, or at any later request) | `Link expired` / `Ask Kaada in your chat for a new setup link.` | `setup-flow.tsx:12`, `use-setup.ts:84-85` → 3.2 | D |
| load failed | `Couldn't load setup` + note `{describeError(error, "Couldn't load your wallet.")}` + `Try again` | `setup-flow.tsx:13-16`, `use-setup.ts:88` | D |

Possible notes for load failed: any `describeError` message from 3.12, else `Couldn't load your wallet.` (S, `use-setup.ts:88`).

### Step 2: Create credential (`SetupCredentialStep`, `setup-credential-step.tsx:12-33`)
Shown when the view is `ready`, `creating` (create/device), or an `error` whose retry is not `load`/`finish`.

| Context / state | Element | Text | Source | K |
|---|---|---|---|---|
| Initial, passkey | Heading | `Secure your wallet` | 3.3 `wallet-setup`/passkey | S |
| | Hint | `Use your fingerprint, face or screen lock.` | | S |
| | Primary | `Create passkey` | | S |
| | Secondary (only when device keys are enabled by the server, not creating, not device-first) | `Use this device` | `setup-credential-step.tsx:26` via `verifyCopy` | S |
| | Footer | `Kaada never sees your passkey or key.` | line 30 | S |
| Creating (passkey) | Button busy label | `Waiting for your device…` | 3.3 | S |
| Creating (device) | Button busy label | `Creating key…` | 3.3 | S |
| After the device-key attempt fails because the browser can't keep a device key (`retry: "device"`) | Heading | `Secure your wallet` | `use-setup.ts:128-133` | S |
| | Hint | `Keep a key on this device and confirm payments with your PIN.` | | S |
| | Primary (device first) | `Use this device` | | S |
| Failure: user cancelled the passkey sheet | Red note | `Cancelled. Nothing was changed.` | `use-setup.ts:259` → 3.11 | S |
| Failure: browser has no WebAuthn and device keys disabled | Red note | `This browser doesn't support passkeys. Open the link in Safari or Chrome.` | `use-setup.ts:218` | S |
| Failure: device key unsupported | Red note | `This browser can't keep a device key. Open the link in Safari or Chrome.` | `use-setup.ts:131` | S |
| Failure: any other passkey error | **Not shown on this screen.** The error has `retry: "load"`, so `setup-flow.tsx:13-16` renders the load-failed screen instead: heading `Couldn't load setup`, note `describeError(…, "Couldn't confirm setup. Reload before trying again.")`, button `Try again` (reloads the page state) | `use-setup.ts:256-261` | D |
| Failure: any device-key error (not 401/502) | Same load-failed screen (heading `Couldn't load setup`), same fallback note | `use-setup.ts:183-189` | D |
| Browser/OS passkey sheet | | (system dialog) | | E |

Note: the first-time enrollment and existing-passkey cases are not separate screens here; this step only ever creates a credential. "Passkey verification" for this flow occurs inside PIN creation (Step 4) and in the other pages.

### Step 3: Finish (`SetupFinalizeStep`, `setup-finalize-step.tsx:6-23`)
Shown when a credential is saved but the wallet is not confirmed (`rootRegistered` true), during `creating/finish`, or after a `retry: "finish"` error.

| State | Text | Source | K |
|---|---|---|---|
| Initial | Heading `Almost done`; description `One last step to create your wallet.`; button `Finish setup` | lines 16, 19 | S |
| Busy | `Finishing…` | line 18 | S |
| Warning (yellow) after server 502 on passkey register | `Your credential is saved. Wallet creation isn't confirmed yet.` | `use-setup.ts:30,245` | S |
| Warning after server 502 on device-key register | `Your device key is saved. Wallet creation isn't confirmed yet.` | `use-setup.ts:173` | S |
| Warning after the finalize call fails | `Your credential is saved. Wallet creation isn't confirmed yet.` | `use-setup.ts:115` | S |

### Step 4: Create PIN (`PinSetup`, `pin-setup.tsx:9-49`, controller `use-pin-setup.ts`)
Entered from `SetupNextStep` once the wallet exists (`setup-next-step.tsx:12`). Wallet already active on load also lands here.

| State | Element | Text | Source | K |
|---|---|---|---|---|
| loading | | `Loading…` | `pin-setup.tsx:11` → 3.2 (subject `setup`) | S |
| PIN already set (`set`) | | nothing rendered (`return null`), parent moves on | line 12 | n/a |
| enter | Heading / description | `Create your PIN` / `You'll use it to approve payments.` | lines 38-39 | S |
| | Keypad submit | `Next` | line 45 | S |
| confirm | Heading / description | `Confirm your PIN` / `You'll use it to approve payments.` | | S |
| | Keypad submit | `Save` | | S |
| working | Heading + note | `Create your PIN` + `Confirming it’s you…` | lines 18-19 | S |
| saved | Heading / description | `PIN saved` / `You can return to your chat.` | line 14 | S |
| mismatch (error) | Red note + `Try again` | `The PINs didn't match. Start again.` | `use-pin-setup.ts:120`, button `pin-setup.tsx:31` | S |
| load error | Red note + `Try again` | `describeError(…, "Couldn't check your PIN.")` | `use-pin-setup.ts:68` | D |
| cancelled the root prompt | Red note (shown in the load-error screen) | `Cancelled. Your PIN wasn't saved.` | `use-pin-setup.ts:97` | S |
| device key missing | | `This browser doesn't hold your device key. Open the link on the device you set up.` | 3.11 | S |
| other failure | | `describeError(…, "Couldn't confirm your PIN was saved. Reload before trying again.")` | `use-pin-setup.ts:98-101` | D |

Observation for your review: `saved` calls `onDone` immediately (`use-pin-setup.ts:76`), and the parent switches screens on that, so the `PIN saved` screen may only flash or never be visible in the setup flow. Runtime verification.

### Step 5a: Recovery setup (only when the wallet is funded) (`setup-next-step.tsx:13`)
`RecoveryCodeCreator` with `standalone` (see F4, section 7).

### Step 5b: Wallet ready (when not funded) (`setup-next-step.tsx:15-16`)
Heading `Wallet ready`; description `You can return to your chat.`; link `Back to Kaada` (Telegram). S.

---

## 6. Page 3: Payment/conversion authorization (`/authorize/[token]`) and Page 4: Extra confirmation (`/root-action/[token]`)

### 6.1 `/authorize/[token]`
Controller `use-authorization.ts`; state machine `authorization-machine.ts`; screens `authorize-flow.tsx`. The server decides (a) the operation (`SEND`/`CONVERT`) and (b) the method (`PASSKEY`, `DEVICE_KEY`, `PIN`) for the wallet (`use-authorization.ts:~22-30`, endpoints `/authorization` and `/authorization/root/method`).

**Step 1: Loading / expired / load error** → 3.2, subject `payment`. Load-error note: `describeError(…, "Couldn't load this payment.")` (`use-authorization.ts:~66`). An unknown operation from the server throws `Unsupported operation` internally and shows this load-error screen (the raw text is not displayed; the fallback is).

**Step 2: Blocked** (`authorize-flow.tsx:36-48`)
| Condition | Heading | Description | K |
|---|---|---|---|
| Method needs a PIN and none is set | `Create your PIN first` | `Ask Kaada in your chat for a security link.` | S |
| Method needs a PIN and a reset is required | `Reset your PIN` | `A PIN can only be replaced through recovery. Nothing was sent.` | S |

**Step 3: Ready / submitting** (`authorize-flow.tsx:49-97`). Uses `VerificationStep` with context `payment` or `conversion` by `operation` (3.3), plus:

| Element | Text | Source | K |
|---|---|---|---|
| Summary: heading line | `{recipient} receives` or `Recipient receives` | `payment-summary.tsx:11` | D |
| Summary: amount | `exactly {amount}` (amount mode EXACT_OUTPUT) or `about {amount}` | line 14-15 | D |
| Summary: minimum | `at least {amount}` (only when not exact output) | line 18 | D |
| Summary: label | `Maximum spend` | line 22 | S |
| Summary: value | `{amount}`; plus `about {amount}` (exact output only) | lines 23-25 | D |
| Summary: footnote | `Estimate. The final price is confirmed before sending and never exceeds the maximum.` | line 30 | S |
| Amounts | formatted by the API (`display` field, e.g. `₦700`) | `session-service.ts` → `summary.ts` | B |
| Lock banner (yellow) | `Too many attempts. Try again in {about a minute / N minutes}.`; the action is hidden while it runs | `authorize-flow.tsx:~76`, 3.11 | D |
| PIN keypad (device-key and PIN methods) | submit label `Confirm`; dots aria-label (3.4) | line 90 | S |
| Passkey method footer | `Passkey not working?` + link `Recover your wallet` | lines 21, 62 | S |
| Device-key method footer | `Lost this device?` + link `Recover your wallet` | `authorize-flow.tsx:22` | S |
| PIN-only method footer | none | | |
| Red notice after a failed attempt | see list below | | |

Failure notices (mapped in `confirm-payment.ts:30-60,97-106`):
| Cause | Notice | K |
|---|---|---|
| 401 with no code | the page switches to the expired screen (3.2) | D |
| `PIN_NOT_SET` / `PIN_RESET_REQUIRED` | switches to the Blocked screens above | S |
| 423, or `lockedUntil` in body | `Too many attempts. Try again later.` + lock banner when the end is known | S |
| `INVALID_PIN` | `Incorrect PIN. {n} attempts left.` / `Incorrect PIN.` | D |
| 429 | `Too many attempts. Wait a moment.` | S |
| `PIN_REQUIRED` | `Enter your PIN.` | S |
| `INSUFFICIENT_BALANCE` | `Not enough balance for this payment and its fee. Nothing was sent.` | S |
| `GAS_FUNDING_REQUIRED` | `Your wallet needs CELO for the network fee. Nothing was sent.` | S |
| `NOT_SENT` | `The payment wasn't sent. Start it again from your chat.` | S |
| anything else | `Couldn't confirm the result. Check your chat before trying again.` | S |
| Prompt cancelled | `Cancelled. Nothing was sent.` | S |
| Device key not in this browser | `This browser doesn't hold your device key. Open the link on the device you set up.` | S |

**Step 4: Done** (`PaymentDone`, `final-pricing.tsx`) with `authorizedTitle` (`app-copy.ts:196-222`) and `paymentDoneCopy` (`app-copy.ts:224-232`).
The heading depends on the proof used and on the server's payment state, which is polled (`follow-payment.ts`). Description is always `You can also return to your chat.` (`app-copy.ts:227`).

| Server payment state (`outcome.state`) | Heading (operation `SEND` / `CONVERT`) |
|---|---|
| none yet, or `PREPARING`, `NOT_STARTED`, `PREPARATION_IN_PROGRESS`, `EXECUTION_READY`, or any state not listed below | `Passkey verified` (method PASSKEY) · `PIN verified` (DEVICE_KEY or PIN) |
| `ROOT_ACTION_REQUIRED` | `One more step` |
| `PROCESSING_PAYMENT`, `PAYMENT_PENDING` | `Sending payment` / `Sending conversion` |
| `PAYMENT_SENT` | `Payment sent` / `Conversion sent` |
| `PAYMENT_FAILED` | `Payment failed` / `Conversion failed` |
| `REAUTHORIZATION_REQUIRED` | `Authorize payment again` / `Authorize conversion again` |
| `INSUFFICIENT_BALANCE`, `GAS_FUNDING_REQUIRED`, `EXECUTION_ROUTE_UNSUPPORTED` | `Payment not sent` / `Conversion not sent` |

Body line (the note under the heading), `final-pricing.tsx:36-39`:
| Condition | Text | Source | K |
|---|---|---|---|
| Server has sent a message | the server's `message` for the current state (table in 6.3) | | B |
| No message yet, method PIN (payment still to be prepared) | `Confirming the final price…` | `app-copy.ts:226` | S |
| No message yet, passkey/device key (payment already running) | `Following your payment…` | `app-copy.ts:225` | S |
| Server reports execution not enabled (`503` on prepare/run) | no note at all (only the heading and description) | `final-pricing.tsx:35` | n/a |
| Network failure while following | `Couldn't confirm your payment's progress. Check your chat before trying again.` | `follow-payment.ts:116` | S |
| Link to the extra confirmation (only when state is `ROOT_ACTION_REQUIRED`, a link was issued and the signer is known) | `Confirm with passkey` (`ROOT_PASSKEY_REQUIRED`) / `Confirm on this device` (`ROOT_DEVICE_KEY_REQUIRED`) | `app-copy.ts:229-231` | S |

### 6.2 `/root-action/[token]`
Controller `use-root-action.ts`; screens `root-action-flow.tsx`. Tab title `Confirm`. The server names the operation and the signer (`/root-action/view`), and supplies one sentence (`message`).

| State | Element | Text | Source | K |
|---|---|---|---|---|
| loading | | `Loading…` | → 3.2 subject `request` | S |
| invalid (401, link used, expired, wallet root changed, operation not found) | | `Link expired` / `Ask Kaada in your chat for a new link.` | → 3.2 | D |
| load error | | `Couldn't load request` + `describeError(…, "Couldn't load this request.")` + `Try again`. Also shown for an unknown action or operation | `use-root-action.ts:~67` | D |
| ready / confirming | Heading, button, busy label | per `payment-root` / `conversion-root` row in 3.3 | | S |
| | Hint (line under heading) | server `message`: `SEND` → `One more confirmation to send this payment.`; `CONVERT` → `One-time confirmation so Kaada can convert between your own currencies without asking each time.` | `root-action-service.ts` `view()` | B |
| | Red notice after a failure | `This browser doesn't hold your device key. …` / `Cancelled. Nothing was changed.` / `Couldn't confirm the result. Check your payment before trying again.` | `use-root-action.ts:113-116` | S |
| done | Heading / body | per 3.3 "Ending": `Passkey verified` or `Confirmed on this device`, then `Your payment continues. Follow it in your chat.` (or `conversion`) | `root-action-flow.tsx:~21` | D |

### 6.3 Server sentences for payment state (shown in the Step 4 note; API-owned)
Source `apps/api/src/core/execution/runner.ts` `runMessage` (lines ~53-77), delivered by `GET /execution/status` and `/execution/outcome`; preparation sentences from `core/execution/preparation-service.ts` `preparationMessage` (lines ~80-99) via `GET /execution/outcome`.

| State | Message |
|---|---|
| `ROOT_ACTION_REQUIRED` | `One more confirmation is needed before this payment can be sent.` (constant `ROOT_ACTION_NOTICE`, also used by the bot) |
| `PROCESSING_PAYMENT` | `Processing your payment...` |
| `PAYMENT_SENT` | `Payment sent.` |
| `PAYMENT_PENDING` | `Your payment is being processed. We'll confirm it as soon as it settles. Please don't send it again.` |
| `PAYMENT_FAILED` | `The payment didn't go through. Please check your wallet and try again.` |
| `REAUTHORIZATION_REQUIRED` | `Please authorize the payment again.` |
| `GAS_FUNDING_REQUIRED` | `Your wallet needs a little CELO to pay network fees before this payment can continue.` |
| `INSUFFICIENT_BALANCE` | `Your wallet no longer holds enough for this payment.` |
| `EXECUTION_ROUTE_UNSUPPORTED` | `This payment route can't be executed yet.` |
| `NOT_READY` (shown as state `NOT_STARTED`) | `Your payment isn't ready yet.` |
| preparation `EXECUTION_READY` | `Payment authorized and final pricing confirmed.` |
| `EXECUTION_BLOCKED` | `Payment authorized, but it needs a manual check before it can continue. Nothing was sent.` |
| preparation `REAUTHORIZATION_REQUIRED` | `The final price is outside what you approved, or your approval is no longer valid. Please authorize again. Nothing was sent.` |
| `FIRM_QUOTE_TOO_CLOSE_TO_EXPIRY` | `The final price expired too quickly. Please try again. Nothing was sent.` |
| `FINAL_PRICE_UNAVAILABLE` | `We couldn't confirm a final price right now. Please try again shortly. Nothing was sent.` |
| `PROVIDER_CAPACITY_REACHED` | `The pricing provider is busy right now. Please try again in a few minutes. Nothing was sent.` |
| preparation `INSUFFICIENT_BALANCE` | `Your wallet no longer holds enough for this payment. Nothing was sent.` |
| preparation `EXECUTION_ROUTE_UNSUPPORTED` | `This payment route can't be executed yet. Nothing was sent.` |
| `PREPARATION_IN_PROGRESS`, or no outcome yet | `Confirming the final price...` (`execution.controller.ts` `view()`) |

All of these are B (the web shows them unchanged). Note the plain wording is "payment" even for conversions. Preparation messages lines 70-82 of `preparation-service.ts` (the first cases of the switch) were not individually read; any case there not in the table above requires runtime verification.

---

## 7. Page 5: Wallet security (`/security/[token]`)

`security-flow.tsx`, `security-action-menu.tsx`, `security-credential-step.tsx`, `security-progress.tsx`, `security-actions.ts`, `use-security.ts`. The `?action=` query selects the screen; no action shows the menu.

### Step 1: Menu (`security-action-menu.tsx:7-16`)
Heading `Wallet security`; description `Choose what to update.`; buttons (from `security-actions.ts`): `Change passkey or device`, `Add a backup`, `Set up recovery`. S. (No loading/expired screen exists on this page; see section 11.)

### Step 2a / 2b: Change credential (`rotate`) and Add backup (`backup`) (`security-credential-step.tsx`)
| Element | `rotate` | `backup` | Source | K |
|---|---|---|---|---|
| Heading | `Change passkey or device` | `Add a backup` | `security-actions.ts:6,12` | S |
| Intro (shown only when idle or after an error) | `Your current passkey or device confirms the change. The old one stops working.` | `A second way in if you lose this device. Your current credential confirms it.` | lines 7, 13 | S |
| Primary (only if passkeys are available) | `Use a new passkey` | `Add a passkey` | `security-credential-step.tsx:28` | S |
| Secondary (only if device keys are available) | `Use a key on this device` | `Add this device` | line 37 | S |
| Neither available | `This browser can’t use a passkey or device key. Open the link in Safari or Chrome.` | same | 3.6 | S |
| Back | `Back` (quiet button, disabled while busy) | | `security-flow.tsx:91` | S |

### Progress states (`security-progress.tsx`, `use-security.ts`)
| State | Text | Source | K |
|---|---|---|---|
| working (prepare) | `Preparing…` | `use-security.ts:91` | S |
| working (new passkey) | `Create the new passkey on your device…` | line 102 | S |
| working (prove current) | `Confirm with your current passkey or device…` | line 126 | S |
| submitted, still confirming (after waiting) | `Submitted and still confirming. Check again shortly.` + button `Check status` | lines 150-151, `security-progress.tsx:22` | S |
| check: still submitted | `Still confirming. Check again shortly.` + `Check status` | `use-security.ts:32` | S |
| check: not confirmed (failed/expired/cancelled) | `This change wasn't confirmed. Review your wallet security before starting another.` | lines 66-67 | S |
| check: request failed | `describeError(…, "Couldn't check yet. Try again shortly.")` + `Check status` | line 76 | D |
| change failed (status not confirmed or submitted) | `The change didn't go through. You can try again.` | line 155 | S |
| unknown result after submitting | `Couldn't confirm the result. Check this change's status before starting another.` + `Check status` | lines 33-34, 159 | S |
| prepare failed | `describeError(…, "Couldn't prepare the change. You can try again.")`; device key missing → 3.11 | lines 164-167 | D |
| done, `rotate` | `Done. Your new credential controls your wallet and the old one no longer works.` | `security-actions.ts:8` | S |
| done, `backup` | `Backup added. Either credential now controls your wallet.` | line 14 | S |
| confirmed (after a manual check) | `Change confirmed.` | `security-progress.tsx:33` | S |

### Step 2c: Set up recovery → F4 below, `standalone`, heading `Recovery setup`.

### F4: Recovery setup (`RecoveryCodeCreator`; used in `/setup` step 5a and `/security?action=recovery`)
Heading `Recovery setup` (`recovery-code-creator.tsx:21`); h1 when standalone (both current uses), else h2. Sub-steps (`use-recovery-code.ts`):

| Sub-step | Element | Text | Source | K |
|---|---|---|---|---|
| loading | note | `Loading…` | `recovery-code-creator.tsx:22` | S |
| email | sub-heading `1. Recovery email` (h3) and the email step below | | `recovery-email-step.tsx:14` | S |
| email, enter / sending / error | description | `Recovery starts from this address. Use one only you can open.` | line ~24 | S |
| | label / placeholder | `Email address` / `you@example.com` | lines 28, 33 | S |
| | button | `Send code`, busy `Sending…` (disabled under 5 characters) | lines 40-46 | S |
| | error | `Enter a valid email address.` (client check) | `use-recovery-email.ts:77` | S |
| | error (429) | `Wait a minute before asking for another code.` | line 96 | S |
| | error (5xx) | `Couldn't send the email. Try again in a few minutes.` | line 98 | S |
| | error (other) | `describeError(…, "Couldn't send the code. Check the address.")` | line 99 | D |
| | load error | `describeError(…, "Couldn't check your email.")` + `Try again` | line 57, `recovery-email-step.tsx:36` | D |
| email, code / checking | description | `If that address can be used, a 6-digit code is on its way to {email}. It expires in 10 minutes.` | lines ~54-55 | D |
| | label / placeholder | `6-digit code` / `000000` | lines 58, 63 | S |
| | buttons | `Verify email` (busy `Checking…`), `Use a different address` | lines 67-81 | S |
| | error | `That code didn't work. It may be wrong or expired.` (rejected) | `use-recovery-email.ts:127` | S |
| | error (other) | `describeError(…, "Couldn't check the code. Try again.")` | line 128 | D |
| email, done | note | `Email verified: {masked}.` or `Email verified.` | `recovery-email-step.tsx:18` | D |
| authenticator, intro | heading `Authenticator app` (h2); text `Link Google Authenticator, Authy, 1Password or similar. You’ll need its 6-digit code to recover your wallet.`; button `Set up authenticator` | `authenticator-enroller.tsx:16-23` | S |
| authenticator, working | `Working…` | line 26 | S |
| authenticator, scan | text `Scan this with your app, or type the key. It’s shown only once.`; QR aria-label `QR code for your authenticator app` (A); key aria-label `Setup key` (A), key text (grouped secret, E/D); label `6-digit code from your app`; placeholder `000000`; button `Confirm code` (busy `Checking…`) | lines 30-60 | S / D |
| authenticator, wrong code | `That code didn’t work. Wait for the next one and try again.` | line 51 | S |
| authenticator, done | `Authenticator app linked.` | line 64 | S |
| authenticator, error | `describeError(…, "Couldn't start authenticator setup.")` + `Start again` | `use-authenticator.ts:49`, enroller line 68 | D |
| intro (recovery code) | `RecoveryNeeds` + `Kaada never sees your Recovery Code. Write it down and keep it away from your phone.` + button `Create Recovery Code` | `recovery-code-intro.tsx:32-37` | S |
| show | the code (aria-label `Your Recovery Code`, A; the code is generated in the browser, E/D); button `I’ve written it down` | `recovery-code-confirmation.tsx:20-31` | S |
| confirm | `RecoveryNeeds`; label `Type the code back`; button `Confirm and save` | lines 37-60 | S |
| confirm, mismatch | `That doesn’t match. Check what you wrote.` | line 49 | S |
| arming | `Confirm with your passkey or this device…` (while the root prompt is open) | `recovery-code-creator.tsx:25` | S |
| done | `Recovery is set up. Keep your Recovery Code and authenticator app safe.` | lines 26-29 | S |
| error | red note (below) + `Start again` | lines 31-37 | D |
| load error | `describeError(…, "Couldn't prepare recovery setup.")` | `use-recovery-code.ts:82` | D |
| save error | device key missing (3.11) or `describeError(…, "Couldn't confirm recovery setup. Reload before trying again.")` | `use-recovery-code.ts:119-122` | D |

---

## 8. Page 6: Wallet recovery (`/recovery`) and Page 7: Stop a recovery (`/recovery/cancel`)

### 8.1 `/recovery` (`recovery-flow.tsx`, `use-recovery.ts`; no token in the URL: the recovery session lives in the browser)
Top-level frame (`recovery-flow.tsx:19-37`): while not ready or while a session loads → `Loading…` (3.2 subject `request`); a red note with the latest error; and, if an error occurs with a session, a `Refresh` button (secondary). Each screen below is shown by `status.nextStep`.

| `nextStep` | Component | Heading | Description | Controls / labels | Source |
|---|---|---|---|---|---|
| (no session) | `RecoveryStart` | `Recover your wallet` | `Enter the email linked to your account. A recovery takes a few days, and we email you when it starts.` | `RecoveryNeeds` block; label `Email address`, placeholder `you@example.com`; button `Start recovery` (busy `Starting…`, disabled under 5 characters) | `recovery-start.tsx:18-36` |
| `VERIFY_EMAIL` | `RecoveryEmail` | `Check your email` | `If that address belongs to a Kaada wallet, we sent a 6-digit code. It expires soon.` | label `6-digit code`, placeholder `000000`; `Verify` (busy `Checking…`, needs 6 digits); `Send a new code` (quiet) | `recovery-email.tsx:18-41` |
| `CREATE_CREDENTIAL` | `RecoveryCredential` | `Set up this device` | `Choose how this device will protect your wallet from now on.` | `Create passkey` (busy `Waiting for your device…`, only if passkeys available); `No passkey? Use a key on this device` (if device keys available); neither → 3.6 | `recovery-credential.tsx:17-35` |
| `PROVE_RECOVERY_FACTORS`, session proposal lost on reload | `RecoveryFactors` | `Prove it’s you` | `This page was reloaded and lost its progress.` | `Start again` | `recovery-factors.tsx:22-25` |
| `PROVE_RECOVERY_FACTORS` | `RecoveryFactors` | `Prove it’s you` | `Your Recovery Code is checked on this device and never sent to Kaada.` | labels `Recovery Code`, `Authenticator code`; placeholder `000000`; `Start recovery` (busy `Checking…`, enabled with a 20+ character code and a 6-digit authenticator code) | `recovery-factors.tsx:31-61` |
| `SUBMITTING`, `WAIT`, `WAITING_FOR_PAYMENT`, `FINALIZING` | `RecoveryWaiting` | `Recovery in progress` | `This delay protects you. The owner of the current device can cancel it from the email link we sent. You can leave and come back on this device.` | With a deadline: `Your wallet moves to this device in about` + live countdown `Xd Yh Zm` (days shown only if > 0; `aria-live="polite"`) ; without a deadline: `Working…` | `recovery-waiting.tsx:12-31` |
| `PROVE_NEW_CREDENTIAL` | `RecoveryProof` | `One quick check` | `Confirm that this device can sign for your wallet.` | `Confirm with this device` (busy `Confirming…`) | `recovery-proof.tsx:14-19` |
| `RESET_PIN` | `PinReset` | `Set a new PIN` → `Enter it again` (after the first entry) | `You’ll use it to approve payments. Your old PIN no longer works.` | keypad submit `Next` → `Save` | `pin-reset.tsx:11-17` |
| `CREATE_RECOVERY_CODE` | `RecoveryFinish` | `Set up recovery again` | `Your old Recovery Code and authenticator app were used up. Create new ones to protect your wallet.` | then the F4 recovery setup (heading `Recovery setup`, h2) | `recovery-finish.tsx:10-11` |
| `DONE` | inline | `Wallet recovered` | `This device now controls your wallet. Your PIN, authenticator app and Recovery Code are set.` | `Close` | `recovery-flow.tsx:46-50` |
| `STOPPED` | inline | `Recovery stopped` | `It was cancelled from the device or passkey that controls your wallet. Nothing changed.` | `Start again` | lines 56-59 |
| `FAILED`, with `blockedReason` | inline | `Recovery couldn’t continue` | `It can’t start right now. Try again later.` | `Start again` | lines 64-71 |
| `FAILED`, no `blockedReason` | inline | `Recovery couldn’t continue` | `Nothing was changed. You can start again.` | `Start again` | |

Error notes (red, `use-recovery.ts`): refresh `describeError(…, "Couldn’t refresh. Your progress is kept; try again.")` (line 125); start `Couldn’t start recovery. Check the email and try again.` (176); email code `That code didn’t work. Try again.` (183); resend `Couldn’t send a new code yet. Wait a moment.` (188); passkey `Couldn’t create your passkey.` (208); device key `Couldn’t create a key on this device.` (223); factors `That didn’t work. Check your Recovery Code and authenticator code.` (254); new credential `Couldn’t confirm your new credential.` (264). Each is the fallback for `describeError` (D); a missing device key shows 3.11 (line 155). PIN reset: `The PINs didn’t match. Start again.` (`use-pin-reset.ts:29`), `describeError(…, "Couldn’t save your PIN. Try again.")` (line 46).

Which backend `nextStep` appears is decided by the API (B); the web only maps it.

### 8.2 `/recovery/cancel#<token>` (`cancel-flow.tsx`, `use-cancel-recovery.ts`)
| State | Heading | Description | Controls | Source |
|---|---|---|---|---|
| invalid / no token | `Link not valid` | `Open the link from the recovery email exactly as it was sent. Links work once.` | – | `cancel-flow.tsx:16-17` |
| ready | `Stop a wallet recovery` | `Someone asked to recover your wallet. If it wasn’t you, stop it now from the device or passkey you normally use. Stopping never moves funds.` | `This wasn’t me. Stop it` | lines 32-42 |
| working | same | same | button busy label `Confirm on your device…` | line 38 |
| error | same | same | red note: device key missing (3.11) or `describeError(…, "Couldn’t confirm the cancellation. Check the recovery status.")` | `use-cancel-recovery.ts:57-62` |
| stopped | `Recovery stopped` | `Your wallet is unchanged. We’ll email you to confirm.` | – | lines 23-24 |

(The `loading` state of this page, if one exists, was not found rendering any text; see section 11.)

---

## 9. Page 8: Error screens, and Page 9: Agent playground (dev)

### 9.1 `error.tsx` → `ApplicationFailure` (3.8)
### 9.2 `global-error.tsx:32-52` (inline-styled, no shared component)
| Element | Text | K |
|---|---|---|
| Heading | `Something went wrong` | S |
| Body | `Kaada hit a problem loading this page. If you already approved an action, check its status in your chat before starting again{ (reference <digest>)}.` | D |
| Button | `Try again` | S |

Two screens say the same thing in different words: `ApplicationFailure` (`Reload`, `If you approved something, check your chat before trying again.`) vs `global-error` (`Try again`, longer sentence). They are shown in different crash situations.

### 9.3 `/dev/agent-playground` (`playground.tsx`, `debug-panel.tsx`; developer tool, not a user flow)
Static: placeholder `Message Kaada, or type a command like /rates` (`playground.tsx:276`); example prompts (lines 19-24: `What's the rate from Naira to Argentine pesos?`, `How much is ₦20,000 in Argentine pesos?`, `What about 20,000?`, `Send 500 AR$ to Maria`, `Send João exactly R$500`, `How much is 2000 pesos in naira?`); intro text lines 54 and 74 (`Send a message to start. This session gets its own identity and chat, shares nothing with any other session, and cannot execute a transaction.` / `New conversation. …`); disabled-action tooltip `Opens a real Kaada page: disabled in the playground` (line 223); errors `The playground is not enabled on the API. Set AGENT_PLAYGROUND=true and restart it.` (39), `Could not start a session.` (82), `The turn failed.` (131), `The callback failed.` (158); user echo `▸ {action label}` (147). Debug panel section titles `Turn`, `Intent and entities`, `Conversation focus`, `Simulated execution`, `Agent responses`, `Execution trace ({n})`, row labels (`result`, `elapsed`, `messages sent`, `type`, `status`, `revision`, `missing`, `country`, `source asset`, `destination asset`, `recipient`), filter placeholder `filter events` (`debug-panel.tsx:27-137`). Bot replies shown in this page are the same bot text as section 10 (B/E). Other strings in these two files were not transcribed line by line: runtime verification.

---

## 10. Telegram bot and API-owned messages that correspond to application actions

These are not in `apps/web`. They are included because they describe the same operations as the pages above (and must agree with them). Source root `apps/api/src`.

### 10.1 Buttons that open application pages (`core/channels/message-service.ts`, `core/channels/payment-status.ts`, `core/conversation/presenter.ts`)
| Button label | Opens | Shown when | Source | K |
|---|---|---|---|---|
| `Set up Kaada` | `/setup` | wallet not set up (welcome, `WALLET_SETUP_REQUIRED`) | `message-service.ts:1359,1461`, `presenter.ts:189` | S |
| `Set up PIN` / `Continue setup` | `/setup` (PIN step) | wallet ready, PIN missing; `Continue setup` when resuming | `conversation/presenter.ts:191-193` | S |
| `Secure my account` / `Continue setup` | `/setup` (recovery step) | PIN set, recovery missing; `Continue setup` when resuming | lines 197-198 | S |
| `Authorize payment` | `/authorize` | an authorization is required (payments; conversions use `✅ Confirm` instead) | `message-service.ts:1337` | S |
| `Continue securely` | `/root-action` | payment waiting for the extra confirmation | `payment-status.ts:~282` | S |
| `✅ Confirm` | (in chat, converts) | conversion offer, one tap | `message-service.ts:1325` | S |
| `▶️ Continue`, `❌ Cancel` | (in chat) | interrupted/active operation | lines 1367, 1428 | S |
| `🌍 Other`, `{flag} {country}` | (in chat) | country question | lines 1381-1388 | D |
| `🔄 Convert to {name}`, `Keep as {name}` | (in chat) | own-currency conversion offer | lines 1399, 1409 | D |
| `📋 Copy address`, `🏷️ Copy my @tag` | copy text | wallet details | lines 1097-1098 | S |
| suggestion buttons | (in chat) | `💰 Fund wallet`, `💸 Send money`, `💱 Today's rates`, `👛 Balance`, `Send from another wallet`, `View wallet address`, `⛽ Fund CELO`, `Fund with local currency` (`core/conversation/capabilities.ts:69-115`) | | S |

### 10.2 Payment progress messages (`payment-status.ts` `describeProgress`, lines ~145-185)
| State | Text | K |
|---|---|---|
| `AWAITING_AUTHORIZATION` | `Waiting for your confirmation on the secure page.` | S |
| `AUTHORIZATION_EXPIRED` | `That payment wasn't confirmed in time, so I cancelled it. Tell me again if you still want to send it.` | S |
| `AUTHORIZATION_CANCELLED` | `That payment was cancelled.` | S |
| `PREPARING` | `Authorized ✅ Confirming the final price…` | S |
| `ROOT_ACTION_REQUIRED` | `One more confirmation is needed before this payment can be sent.` (same constant as 6.3) | S |
| `PROCESSING` | `Processing your payment…` | S |
| `PENDING` | `Confirming your payment… It has been submitted and is still confirming. You don't need to do anything, and please don't send it again.` | S |
| `COMPLETED` | `{acknowledgement}\n\n{closing}`: acknowledgement `Done ✅ Your payment has been sent.` / `All done ✅ Your payment is on its way.` / `Sent ✅ Your payment is on its way.`; closing `Anything else?` / `Anything else I can help with?` (variant chosen by a stable seed); fallback `Payment sent ✅` | S / D |
| `FAILED` | `The payment didn't go through, and your funds are safe.{ Reference: <code>.}` | D |
| `INSUFFICIENT_BALANCE` | `You don't have enough funds for this payment.` | S |
| `REAUTHORIZATION_REQUIRED` | `The price or the authorization changed before the payment went out, so nothing was sent. Ask me to set the payment up again and you'll confirm it once more.` | S |
| `GAS_FUNDING_REQUIRED` | `Your wallet needs a little CELO to cover network fees before this payment can be sent.` | S |
| `NO_ROUTE` | `I can't send this kind of payment yet, so nothing was sent and your funds are safe. You can send to a wallet address in the same currency instead.` | S |
| fallback notification | `There is an update on your Kaada account.` (`notification-service.ts:94`) | S |

### 10.3 Authorization summary message (`core/channels/presenter.ts:43-62,88-109`)
Lines assembled in the chat before the authorization button: `Conversion` or `Payment to {recipient}`; `You get`/`They receive exactly: {amount}`; `You spend: about {a}, never more than {b}`; `You spend exactly: {a}`; `{You get|They receive}: about {a}, at least {b}`; `Fees: {a + b}`; `(Test prices: no real money moves.)` when mock; closing line `Tap Confirm and I'll convert it. Nothing leaves your wallet.` (conversion) or `You confirm with your 6-digit PIN on a secure Kaada page. Never type it in this chat.` (payment). D.

### 10.4 Errors and prompts (`presenter.ts:133-179`, `message-service.ts`)
`To send money you first need to set up your Kaada wallet. It takes a minute and happens on a secure page.` · `I can't find an available route for that payment right now. Try a different amount or currency.` · `Pricing is temporarily unavailable. Please try again in a moment.` · `That option is no longer available. Tell me what you'd like to do and I'll start from where we are.` · `{text}\n\nWant to fund your wallet?` · `{text}\n\nWant to fund your wallet and come back to it?` · `Something went wrong on my side. Please try again in a moment.` (`message-service.ts:220`) · `I only work in private chats. Message me directly to send money.` (248) · `I can't take requests yet. Please try again later.` (351) · `That button was already used.` / `That button is no longer available. Tell me what you'd like to do.` (807-808) · `That button is no longer available.` (815) · `Tell me what you'd like to send and I'll set it up.` (849) · `That choice isn't available.` (866) · `Okay, I'll keep that in {name}.` / `Okay, I'll keep it as it is.` (892) · `Converting now. I'll tell you as soon as it's done.` / `That conversion is no longer available. Tell me what you'd like to convert and I'll set it up again.` (916-917) · `Sure 👍 Who are we sending to, and how much? For example “Send Daniel $20”.` / `Okay! Tell me who it's for and how much, like “Send Daniel $20”.` (954-955) · `Rates aren't available right now.` (1009) · `You received {list} 💰` (691). Several `text` fields in `AgentResponse` (clarifications, balance, quote, error) are produced in `core/responses/*.ts` and `core/agent/*`; see 10.7. S/D/B.

### 10.5 Onboarding messages (`core/conversation/fallbacks.ts:158-196`, `message-service.ts:202-203,526,1451-1461`)
| State / context | Text |
|---|---|
| Welcome, wallet needed (`ONBOARDING_WALLET_NEEDED`) | `Welcome to Kaada 👋` · `I can help you send money, check rates and manage payments right here.` · `First, let's get your wallet ready. It takes a minute on a secure Kaada page: your keys and PIN never go through this chat.` (alt: `Welcome to Kaada! I send money across borders for you, from this chat.\n\nFirst, set up your wallet. …`, `message-service.ts:1460`; unavailable: `Welcome to Kaada. Wallet setup isn't available yet, please check back soon.`, lines 526, 1456) |
| PIN needed, `RESUMING` | `Looks like your wallet is ready, but your PIN still needs setting up.` · `Want to finish that?` |
| PIN needed, `CHECK_IN` | `Yep, your wallet is ready 🎉` · `One more step: set up your 6-digit PIN so you can approve payments securely.` |
| PIN needed, just created | `Wallet ready 🎉` · `Now set up your 6-digit PIN. You'll use it to approve payments without having to confirm with your root credential every time.` |
| Recovery needed, `RESUMING`/`CHECK_IN` | `Your wallet and PIN are ready 👍` · `Recovery is the one step left: add your email, link an authenticator app and save a Recovery Code, so you can always get back into your wallet if you lose your device.` |
| Recovery needed, just done PIN | `Your PIN is set 👍` · `One last step: set up recovery. You'll add your email, link an authenticator app and save a Recovery Code, so you can always get back into your wallet if you lose your device. It takes a few minutes on the secure page.` |
| Complete | `You're all set ✅ Your Kaada wallet is ready to use.` · `What do you want to do first?` |
| Returning | `Hey 👋 Good to see you again.` / `Welcome back 👋` + questions; or `Welcome back to Kaada.\n\n{HELP}` |
| Country question | `Where will you mainly use Kaada?` · `Your Kaada account is ready ✅\nOne last thing: where will you mainly use Kaada? This helps me choose your default currency.` |
| Help (`HELP`, `message-service.ts:179-180`) | `I can send money for you. Try “Send Daniel $20” or “Send João R$500”. I'll show you the payment, and you confirm it with your 6-digit PIN on a secure Kaada page.\n\nCommands: /cancel stops what we're doing, /help shows this.` |
| Typed six digits | `That looks like a PIN. Never type your PIN here: I've removed it from this chat. You confirm payments with your PIN on the secure Kaada page I link to.\n\n(If you meant an amount, add the currency, for example “250000 NGN”.)` (`PIN_WARNING`, line 193) |

Observation for your review (cross-surface): the PIN-needed text says the PIN avoids "confirm with your root credential every time", while the web's setup PIN screen says `You'll use it to approve payments.`

### 10.6 Commands and funding (`core/channels/commands.ts`, `core/conversation/funding.ts`)
Telegram menu descriptions (`commands.ts:18-28`): `Start, or pick up where you left off` · `What I can do` · `Check your wallet balance` · `How to add funds to your wallet` · `Your wallet address` · `Check today's rates` · `Choose your country and default currency` · `Cancel what we're doing`. Help list (lines 34-42): `Here's what I can do 👋`, `💸 Send money. Just tell me, like “Send Daniel $20”.`, `💱 Check today's rates.`, `👛 Show your balance.`, `💰 Help you fund your wallet.`, `Shortcuts: /…`. Funding (`funding.ts`): `Sure 👍 You can fund your Kaada wallet from another wallet.`, `Network: {n}\nWallet: {address}`, `Your Kaada tag: @{tag}\nPeople on Kaada can send you money with it.`, `Only send supported currencies on the {n} network to this address. Funds sent on another network, or unsupported assets, may not appear in Kaada and may be difficult or impossible to recover.`, `Your Kaada wallet\nNetwork: …\nAddress: …`, `Your Kaada wallet currently supports:\n…`, `Your Kaada wallet works with these currencies on the {n} network:\n…`, `CELO: yes, you can receive and send CELO, Celo's own coin, at your wallet address. It also pays the network fee for every transfer, so keep a little in your wallet.`, `Anything else, or funds sent on another network, may not appear in Kaada and may be difficult or impossible to recover.`, `Your wallet isn't ready yet. Send /start and I'll take you through the setup.`, `That way of funding your wallet isn't available.`, `Funding your wallet from here isn't available yet.`, `To cover the network fee, send a small amount of CELO to your Kaada wallet.\n\nNetwork: {n}\nWallet: {address}`. S/D.

Resume prompts (`core/conversation/resume.ts:9-14`): `You were sending {amount} to {recipient}. Want to continue?` · `You were converting {amount}. Want to continue?` · `You have a payment in progress. Want to continue?`.

### 10.7 Conversational fallback wording (`core/conversation/fallbacks.ts`) and clarifications (`core/responses/clarifications.ts`)
Fixed fallback pieces for greeting, small talk, capabilities, out-of-scope, rates, balance, missing recipient/amount/currency, payment correction, ambiguity, funding options, conversation end, payment completed, etc. are in `fallbacks.ts:45-263` (about 60 fixed phrases and variants, for example `Hey 👋 How's your day going?`, `Which rate would you like to check? Tell me the pair, like USDT to cNGN.`, `Who should I send it to?`, `How much are we sending?`, `Alright, here's what I've got 👇` / `Everything look good?`). Clarification questions (`clarifications.ts:47-135`): `That needs to be more than zero. How much would you like to {send|convert}?`, `How much would you like to {verb}?`, `What currency is the {subject} in?`, `I found too many matches for {subject}. Can you give me their @username or full name?`, `Which currency or token do you want to convert from?`, `Which currency or token do you want to receive?`, `You need a wallet before you can do that.`, `That's the same currency on both sides. What would you like it in instead?`, `I don't support {subject} yet. Which currency would you like to use instead?`, and others. Request summaries (`core/responses/summaries.ts:45-54`): `You're sending {amount} to {recipient}{where}`, `Got it: convert …`, `Got it: a quote for … I'll look up a price next. Nothing will be sent.`. These were extracted by scanning for string literals, not exhaustively transcribed. **Runtime verification / full transcription needed** if you want every variant.

### 10.8 Emails sent during recovery (`core/recovery/messages.ts`)
| Email | Subject | Body (template) | K |
|---|---|---|---|
| Verification code | `Your Kaada recovery code` | `Your Kaada verification code is {code}.` / `It expires at {time} and works once.` / `Kaada will never ask you for this code anywhere except the recovery page you opened.` / `If you did not ask to recover your wallet, ignore this message: nothing happens without it.` | D |
| Not set up | `Kaada wallet recovery` | `Someone asked to recover the Kaada wallet linked to this email, but recovery is not set up for it.` · `If this was you, open Kaada on a device where you can still use your wallet and set up a Recovery Code first.` · `If it was not you, no action is needed.` | S |
| Blocked | `Kaada wallet recovery` | `A wallet recovery for this email cannot start right now (a recent recovery or too many attempts).` · `If this was you, please try again later. If it was not you, no action is needed.` | S |
| Started | `Kaada: wallet recovery requested` | `A recovery of your Kaada wallet was requested.` · `It is waiting for a safety delay and will complete around {time} (in about {n hours / n days}).` · `If this was you, you do not need to do anything.` · `If this was NOT you, stop it now from the device or passkey you normally use: open this link there. Do not share it.` · link `{web}/recovery/cancel#{token}` · `Only your current device or passkey can cancel a recovery. Until it completes, nothing about your wallet has changed.` | D |
| Cancelled | `Kaada: wallet recovery cancelled` | `The pending recovery of your Kaada wallet was cancelled from your current device. Nothing changed.` | S |
| Completed | `Kaada: wallet recovered` | `Your Kaada wallet was recovered on {time}. The old device can no longer control it.` · `Your PIN must be set again, and you will set up a new authenticator app and a new Recovery Code.` · `If this was NOT you, contact Kaada support immediately.` | D |

The same recovery subject and body are also sent as Telegram messages for `RECOVERY_STARTED/CANCELLED/COMPLETED` (`notification-service.ts:68-82`).

### 10.9 Model-written text (external / runtime)
When a language model is configured (Groq, Anthropic or OpenAI-compatible transports under `infrastructure/llm/`), most conversational replies, rate/balance wrappers and onboarding replies are written by the model within the constraints in `core/conversation/instructions.ts` and `states.ts` (`STATE_MODE` decides deterministic vs model-wrapped per state). Those words **cannot be listed from code** and are marked E / runtime verification. Without a model, `ConversationPresenter` uses the fixed fallback wording above.

---

## 11. Coverage, gaps and things that could not be verified

Could not or did not verify:
1. **Legal pages** (`/privacy`, `/terms`, `/risk`): routes listed, content not transcribed (assumption 2).
2. **Model-written bot text** (10.9): not enumerable.
3. **Bot message-service strings**: `message-service.ts` is 1464 lines; strings were collected by scanning for string literals, plus the lines read around presentation. Strings built by helpers in `core/conversation/presenter.ts`, `reply.ts`, `states.ts`, `instructions.ts` (instructions are prompts for the model, not shown to people), `core/agent/*.ts`, `core/routing/format.ts`, `core/routing/rate-answer.ts`, `core/wallets/*` and `core/channels/funding-announcer.ts`/`onboarding-announcer.ts` (which announce "you received …" and onboarding completion) were only partly read. The deterministic parts found are in section 10; the remainder needs a transcription pass if wanted.
4. **`preparationMessage` first cases** (`preparation-service.ts` lines ~70-82) not individually read (6.3).
5. **Exact rendering of `RecoveryNeeds`** (which of the three lists/lines render, 3.10).
6. **Components not inspected line by line**: `app/dev/agent-playground/*` (9.3), `app/components/legal/*`, `app/components/ui/*` (dialog, accordion, scroll-area, staggered menu: part of the landing page or unused by the application; none is imported by an application route that was read, but this was not checked by import graph).
7. **Toasts, tooltips, modals, drawers, dialogs**: none were found in the application pages (no toast library or `<dialog>` is used by any inspected application file). The only tooltip-like text is the playground `title=` attribute (9.3). The only dialogs are the browser's passkey sheet and the app's own inline screens.
8. **Tabs, dropdowns, menu items, empty states**: none exist in the application (the security menu is a list of buttons; there is no history/beneficiary list to be empty).
9. **Unreferenced copy**: `LinkSubject` value `security` (`app-copy.ts:~139`) and the `SecurityActionMenu` flow do not use a `FlowStatus` loading/expired screen (the security page has no token check on load, so an invalid token only surfaces when an action is attempted: runtime verification). `PIN saved` screen reachability (section 5, Step 4).
10. **Telegram client rendering**: button text may be clipped by `clip()` (`telegram-adapter.ts:399,412`); a button with a `description` renders `{label} ({description})`.
11. **Browser-supplied text**: passkey/OS prompts, native validation messages for `type="email"`.
12. **Server error `message` bodies** from the API (NestJS exceptions, the proxy's JSON `message`) are deliberately never displayed by the web; they are not part of the user-visible inventory.

Cross-surface observations (for your review; no judgement applied): the same event is worded differently in several places (examples: the extra confirmation is `One more confirmation is needed before this payment can be sent.` on the page note and in the bot, but the page heading says `One more step`; the bot says `Authorize payment` on its button while `/authorize`'s tab says `Authorize payment` and the heading says `Authorize payment` for PIN-only and `Confirm payment` for passkey/device).

---

## 12. Summary of the inventory

Counts below are taken from the tables in this file (see the method note).

Method: counted from this file. "Text spans" are quoted pieces of displayed text in the tables, excluding file paths and code identifiers; they overcount slightly (a template and its example variants are separate spans). These are estimates, not a certified total.

| Measure | Result |
|---|---|
| Routes/pages listed | **13** (8 application UI routes incl. the dev playground, 3 legal routes whose body is not transcribed, 2 error boundaries). Excluded: landing page, API proxy routes |
| Flows | **13** (F1-F13; F13 is the Telegram counterpart) |
| Steps / screens documented | **about 46**: about 35 screens (setup 6, authorize 4, root-action 1 table of 5 states, security 4, recovery 12 `nextStep` screens, recovery-cancel 4, errors 2, home 1) plus 11 sub-steps of the recovery setup (F4) |
| Unique text entries | **about 594** distinct text spans (about 380 of them in the web app, about 210 in bot/email/API text) |
| Contextual occurrences (repeats counted) | **about 775** text spans across the file; shared strings reused in several flows are listed once with every location (3.11, 3.12) rather than repeated |
| Dynamically generated messages (templates with placeholders or state-dependent output) | **about 52** templates with `{…}` placeholders, plus 40 table rows tagged D |
| Backend/external-sourced messages | **20** API sentences that the web shows verbatim (6.3: 18 payment-state sentences, 2 root-action hints); **about 210** bot/email/API text spans in section 10; plus all model-written text (not countable) |
| Accessibility-only text | **6 strings** (`Kaada home`, `{n} of 6 digits entered`, `Delete`, `QR code for your authenticator app`, `Setup key`, `Your Recovery Code`; `role=status/alert` on notes) |
| Needs runtime verification | see section 11: legal pages, model-written text, partial bot transcription (section 11 item 3), `preparationMessage` first cases, `RecoveryNeeds` rendering, `PIN saved` reachability, security page load behaviour, playground text, and any text from provider or browser dialogs |
