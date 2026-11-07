# Kaada application: UI copy validation

Second audit, review and recommendations only. Nothing in the application was changed. It builds on `docs/application-ui-copy-inventory.md` (the inventory) and answers a different question: **do the words on each screen, taken together, match what the person is doing and what the backend knows, and does every line earn its place?**

Scope: the application at `app.kaada.xyz` (`apps/web/app`: `/`, `/setup`, `/authorize`, `/root-action`, `/security`, `/recovery`, `/recovery/cancel`, the two error screens). Not covered: landing page, legal pages, the dev playground, unrelated docs. Backend or bot text appears only where the application actually displays it, or where it contradicts a screen the same person is looking at (marked "cross-surface").

How to read it:

- **Section 1** is the summary.
- **Section 2** lists, per screen and state, exactly what is rendered together, in visual order. Elements that cannot appear together are separate states. Every screen also has the shell header with the badge `Secure` and the logo link; those are left out below.
- **Section 3** is the findings table. IDs (`V01`…) are referenced from the screens.
- **Section 4** follows each operation through its whole lifecycle.
- **Section 5** is the terminology check.
- **Section 6** corrects the earlier inventory and states what I could not verify.

Classification codes: **IC** incorrect context · **CM** contradictory messaging · **RD** redundant messaging · **EX** excessive text · **AM** ambiguous instruction · **IS** incorrect status · **IT** inconsistent terminology · **OK** appropriate as written.

Rendering conditions were traced in code (`VerificationStep`, `FlowSection`, `FlowStatus`, the state machines and the page components). Where behaviour depends on the backend at runtime, the finding says "verify at runtime" instead of guessing.

---

## 1. Summary

| Measure | Result |
|---|---|
| Screens and states composed (section 2) | **69** (each listed with every element drawn together) |
| Findings (section 3) | **59** |
| Incorrect context (IC) | 5 |
| Contradictory messaging (CM) | 5 |
| Redundant messaging (RD) | 9 |
| Excessive text (EX) | 3 |
| Ambiguous instruction (AM) | 15 |
| Incorrect status (IS) | 4 |
| Inconsistent terminology (IT) | 13 |
| Appropriate as written (OK) | 5 |
| Severity: High / Medium / Low (excluding OK) | 4 / 24 / 26 |
| Findings that need a runtime check before deciding | 6 (V13, V19, V20, V31, V49, V67) |


The biggest problems, in order of how much they mislead a person:

1. **Headings that sound like success above a failure.** On the payment done screen, four preparation failures (`EXECUTION_BLOCKED`, `FIRM_QUOTE_TOO_CLOSE_TO_EXPIRY`, `FINAL_PRICE_UNAVAILABLE`, `PROVIDER_CAPACITY_REACHED`) keep the heading `PIN verified` / `Passkey verified` over a note that says `Nothing was sent` (V01). This is a gap in the previous round's change, not original code.
2. **Recovery-error screens that retry something that cannot work.** Setup shows `Use this device` or `Create passkey` as the main button directly under a note saying this browser cannot do it (V24, V25).
3. **The wrong kind of screen for a failure.** A failed passkey or device-key creation is drawn as `Couldn't load setup` (V26).
4. **Repetition on the screens people see most.** The root-action screen says "confirm" three times (heading, hint, button). The payment done screen repeats the heading in the note for `Payment sent` and `Sending payment`. Recovery setup repeats a five-line "you need all three" block on four consecutive steps.
5. **One event, several different words.** "Authorize / Confirm / Approve", "credential / passkey / device / key", "wallet / account", "Check your chat / Check your payment".

Nothing here removes a security warning or a financial disclosure. Where one is kept on purpose it is marked OK.

---

## 2. Screen compositions

Format: elements in the order they are drawn. `[ ]` marks an element drawn only under the stated condition. Verdict ends each screen.

### 2.A Application home (`/`)

**A1. Home**
1. Heading `Your Kaada wallet`
2. Description `Send money and manage your wallet from Telegram.`
3. Primary link `Open Kaada in Telegram`
4. Secondary link `Recover your wallet`

Verdict: short and useful. The heading promises a wallet view that the page does not have (V62, minor).

### 2.B Wallet setup (`/setup/[token]`)

**B1. Loading** · 1. `Loading…` (plain status line, no heading).
**B2. Link expired** · 1. Heading `Link expired` 2. `Ask Kaada in your chat for a new setup link.` (V15, V16)
**B3. Load failed** · 1. Heading `Couldn't load setup` 2. Red note `{reason}` 3. Button `Try again`.

**B4. Create credential, passkey, first visit** (device keys enabled by the server)
1. Heading `Secure your wallet`
2. Description `Use your fingerprint, face or screen lock.`
3. Primary button `Create passkey`
4. Secondary button `Use this device`
5. Footer `Kaada never sees your passkey or key.`

**B4b.** Same without item 4 when device keys are disabled. **B4c.** While creating: the primary button shows `Waiting for your device…` (passkey) and the secondary button is hidden.
Verdict: the heading does not say what the person is doing: this is wallet creation (tab: `Set up your Kaada wallet`; bot button `Set up Kaada`). V27. Footer is a security disclosure: OK (V33).

**B5. After cancelling the passkey sheet** · same as B4 plus a red note between description and button: `Cancelled. Nothing was changed.` Verdict: correct.

**B6. Browser has no passkeys, device keys disabled** · same as B4 with red note `This browser doesn't support passkeys. Open the link in Safari or Chrome.` and **the same primary button `Create passkey`**. V25.

**B7. Device key unsupported (device-first)** · 1. Heading `Secure your wallet` 2. Description `Keep a key on this device and confirm payments with your PIN.` 3. Red note `This browser can't keep a device key. Open the link in Safari or Chrome.` 4. Primary button `Use this device` 5. Footer `Kaada never sees your passkey or key.` (the passkey button is gone). V24.

**B8. Any other creation failure (passkey or device key)** · drawn by the load-failed screen: 1. Heading `Couldn't load setup` 2. Red note `Couldn't confirm setup. Reload before trying again.` (or a mapped message) 3. Button `Try again`. V26.

**B9. Finish, first visit** (credential saved, wallet not confirmed)
1. Heading `Almost done`
2. Description `One last step to create your wallet.`
3. Button `Finish setup` (busy: `Finishing…`)
**B9b. After a failed finish** · adds a yellow note between description and button: `Your credential is saved. Wallet creation isn't confirmed yet.` (device-key variant: `Your device key is saved. …`).
Verdict: `One last step` is not true (V28).

**B10. PIN, enter** · 1. Heading `Create your PIN` 2. `You'll use it to approve payments.` 3. Keypad (dots, 0-9, ⌫, `Next`).
**B11. PIN, confirm** · 1. Heading `Confirm your PIN` 2. same description 3. Keypad (`Save`). V30.
**B12. PIN, saving** · 1. Heading `Create your PIN` 2. Note `Confirming it’s you…`. V29.
**B13. PIN, mismatch** · 1. Heading `Create your PIN` 2. Red note `The PINs didn't match. Start again.` 3. Button `Try again`.
**B14. PIN, other failure** · same shape; note is `Cancelled. Your PIN wasn't saved.`, the device-key message, or a mapped/fallback message; button `Try again` (reloads).
**B15. PIN saved** · 1. Heading `PIN saved` 2. `You can return to your chat.` (the parent moves on at once, so this is at most a flash: V31).
**B16. Wallet ready** (not yet funded) · 1. Heading `Wallet ready` 2. `You can return to your chat.` 3. Link `Back to Kaada`. V32.
**B17. Wallet ready, funded** → recovery setup (F-screens in 2.F).

### 2.C Payment / conversion authorization (`/authorize/[token]`)

**C1. Loading** `Loading…`. **C2. Expired** `Link expired` / `Ask Kaada in your chat for a new payment link.` (V15, V16). **C3. Load failed** `Couldn't load payment` + red note + `Try again`.

**C4. Ready, passkey wallet, payment**
1. Heading `Confirm payment`
2. (no description)
3. Summary: `{Recipient} receives` · `about|exactly {amount}` · [`at least {amount}`] · `Maximum spend` · `{amount}` · [`about {amount}` for exact amounts] · footnote `Estimate. The final price is confirmed before sending and never exceeds the maximum.`
4. [Red note after a failed attempt]
5. Button `Confirm with passkey` (busy: `Waiting for your passkey…`)
6. Footer `Passkey not working?` + link `Recover your wallet`
Verdict: financial content is exactly what must stay (OK). Footer wording V10. Heading verb V07.

**C5. Ready, device-key wallet, payment**
1. Heading `Confirm payment`
2. Description `Enter your PIN.`
3. Summary (as C4)
4. [Yellow lock note `Too many attempts. Try again in {about a minute | N minutes}.` or red note]
5. Keypad: PIN dots (screen-reader label `{n} of 6 digits entered`), 0-9, `⌫`, key `Confirm`
6. Footer `Lost this device?` + link `Recover your wallet`
The copy table also defines `Confirm` / `Confirming…` for this state, but the keypad replaces the button, so those words are never shown (V08).

**C6. Ready, PIN-only wallet, payment** · as C5 with heading `Authorize payment` and no footer. (`Authorize`, `Authorizing…` also never shown: V08.) V07: C5 and C6 are the same screen with different headings.

**C7. Locked** · as C5/C6 with the lock note replacing any red note and **the keypad hidden**; footer stays.

**C8. Ready, conversion** (only reachable through a direct link, because the bot confirms conversions with one tap and sends no link: `message-service.ts:1320-1330`) · headings `Confirm conversion` / `Authorize conversion`; the summary still reads `Recipient receives` (V09).

**C9. Blocked, no PIN** · 1. Heading `Create your PIN first` 2. `Ask Kaada in your chat for a security link.` (V11)
**C10. Blocked, PIN reset required** · 1. Heading `Reset your PIN` 2. `A PIN can only be replaced through recovery. Nothing was sent.` (V12)

**C11. Done.** One screen with four slots; what fills them depends on the server's state. Slots: 1. Heading 2. Description (always `You can also return to your chat.`) 3. Note 4. [Link].

| Server state | 1 Heading | 3 Note | 4 Link | Verdict |
|---|---|---|---|---|
| none yet, PIN wallet | `PIN verified` | `Confirming the final price…` | | OK as a status; V05 on the description |
| none yet, passkey/device wallet | `Passkey verified` / `PIN verified` | `Following your payment…` | | OK |
| execution not enabled (503) | `PIN verified` / `Passkey verified` | (none) | | the person is told nothing is running: V05 |
| `EXECUTION_READY` | unchanged | `Payment authorized and final pricing confirmed.` | | OK |
| `NOT_STARTED` (right after ready) | unchanged | `Your payment isn't ready yet.` | | V67: contradicts the line above if both appear in turn |
| `ROOT_ACTION_REQUIRED` | `One more step` | `One more confirmation is needed before this payment can be sent.` | `Confirm with passkey` / `Confirm on this device` (only if the signer is known) | V04, V05 |
| `PROCESSING_PAYMENT` | `Sending payment` | `Processing your payment...` | | V03 |
| `PAYMENT_PENDING` | `Sending payment` | `Your payment is being processed. We'll confirm it as soon as it settles. Please don't send it again.` | | OK |
| `PAYMENT_SENT` | `Payment sent` | `Payment sent.` | | V02 |
| `PAYMENT_FAILED` | `Payment failed` | `The payment didn't go through. Please check your wallet and try again.` | | V68 |
| `REAUTHORIZATION_REQUIRED` | `Authorize payment again` | `Please authorize the payment again.` | | RD (V03-style) |
| `INSUFFICIENT_BALANCE`, `GAS_FUNDING_REQUIRED`, `EXECUTION_ROUTE_UNSUPPORTED` | `Payment not sent` | server sentence (ends `Nothing was sent.` for preparation, not for run) | | OK, RD in part |
| `EXECUTION_BLOCKED`, `FIRM_QUOTE_TOO_CLOSE_TO_EXPIRY`, `FINAL_PRICE_UNAVAILABLE`, `PROVIDER_CAPACITY_REACHED` | **`PIN verified` / `Passkey verified`** | sentence ending `Nothing was sent.` | | **V01** |
| network failure while following | `PIN verified` / `Passkey verified` | `Couldn't confirm your payment's progress. Check your chat before trying again.` | | V01 (same cause) |

### 2.D Extra confirmation (`/root-action/[token]`)

**D1. Loading** `Loading…`. **D2. Link not usable** `Link expired` / `Ask Kaada in your chat for a new link.`: shown for expired, already-used, replaced, wrong-wallet or operation-not-found links alike (V15). **D3. Load failed** `Couldn't load request` + red note + `Try again`.

**D4. Ready, passkey root, payment**
1. Heading `Confirm payment with passkey`
2. Description (server) `One more confirmation to send this payment.`
3. [Red note]
4. Button `Confirm with passkey` (busy `Waiting for your passkey…`)
**D5. Ready, device-key root, payment** · heading `Confirm payment on this device`, same description, button `Confirm with this device` (busy `Confirming…`).
**D6. Ready, conversion** · headings `Confirm conversion with passkey` / `Confirm conversion on this device`; description `One-time confirmation so Kaada can convert between your own currencies without asking each time.`
Verdict: three lines saying "confirm" (V18); the SEND description and the CONVERT description disagree on whether it repeats (V19).

**D7. Failure notes** · `This browser doesn't hold your device key. Open the link on the device you set up.` / `Cancelled. Nothing was changed.` / `Couldn't confirm the result. Check your payment before trying again.` (V14, V23).
**D8. Done** · 1. Heading `Passkey verified` / `Confirmed on this device` 2. `Your payment continues. Follow it in your chat.` (conversion: `Your conversion continues…`). No button. (V20, V21)

### 2.E Wallet security (`/security/[token]`)

**E1. Menu** · 1. Heading `Wallet security` 2. `Choose what to update.` 3. Buttons `Change passkey or device`, `Add a backup`, `Set up recovery`. Verdict OK. The page has no loading or expired screen; an invalid link first shows up as an error after an action (V48).

**E2. Change passkey or device, idle or after an error**
1. Heading `Change passkey or device`
2. Description `Your current passkey or device confirms the change. The old one stops working.`
3. [Red note]
4. [`This browser can’t use a passkey or device key. Open the link in Safari or Chrome.` if neither is available]
5. [Button `Use a new passkey`] [Button `Use a key on this device`]
6. Button `Back`
**E3. Add a backup, idle** · same with heading `Add a backup`, description `A second way in if you lose this device. Your current credential confirms it.`, buttons `Add a passkey`, `Add this device`.
**E4. Working** (description and buttons hidden) · 1. Heading 2. Note, one of `Preparing…` → `Create the new passkey on your device…` → `Confirm with your current passkey or device…` 3. `Back` (disabled). OK: each line matches the real step.
**E5. Pending** · 1. Heading 2. Note `Submitted and still confirming. Check again shortly.` / `Still confirming. Check again shortly.` / `Couldn't confirm the result. Check this change's status before starting another.` 3. Button `Check status` 4. `Back`. OK.
**E6. Done** · 1. Heading 2. Green note: rotate `Done. Your new credential controls your wallet and the old one no longer works.`; backup `Backup added. Either credential now controls your wallet.` 3. `Back`. V42, V43.
**E7. Confirmed after "Check status"** · 1. Heading 2. Green note `Change confirmed.` (V44).

### 2.F Recovery setup (`RecoveryCodeCreator`, shown in setup after funding and at `/security?action=recovery`)

Always on top: Heading `Recovery setup` (h1).

**F1. Email entry** · 2. `RecoveryNeeds` box (`To recover your Kaada wallet, you'll need all three:` · three bullets · `If you lose your Recovery Code or your authenticator app, Kaada cannot restore your wallet.`) 3. Sub-heading `1. Recovery email` 4. `Recovery starts from this address. Use one only you can open.` 5. [Red note] 6. Label `Email address`, placeholder `you@example.com` 7. Button `Send code`.
**F2. Email code** · 2. `RecoveryNeeds` 3. `1. Recovery email` 4. `If that address can be used, a 6-digit code is on its way to {email}. It expires in 10 minutes.` 5. `6-digit code` field 6. `Verify email` 7. `Use a different address`. V34, V35, V36.
**F3. Authenticator, intro** · 2. `RecoveryNeeds` 3. Heading `Authenticator app` 4. `Link Google Authenticator, Authy, 1Password or similar. You’ll need its 6-digit code to recover your wallet.` 5. `Set up authenticator`.
**F4. Authenticator, scan** · 2. `RecoveryNeeds` 3. Heading `Authenticator app` 4. `Scan this with your app, or type the key. It’s shown only once.` 5. QR 6. key 7. `6-digit code from your app` field 8. [red `That code didn’t work. Wait for the next one and try again.`] 9. `Confirm code`.
**F5. Recovery Code intro** · 2. `RecoveryNeeds` 3. `Kaada never sees your Recovery Code. Write it down and keep it away from your phone.` 4. `Create Recovery Code`.
**F6. Recovery Code shown** · the code, then `I’ve written it down` (no other text).
**F7. Recovery Code confirm** · 2. `RecoveryNeeds` 3. `Type the code back` field 4. [red `That doesn’t match. Check what you wrote.`] 5. `Confirm and save`.
**F8. Arming** · note `Confirm with your passkey or this device…` (V38).
**F9. Done** · green note `Recovery is set up. Keep your Recovery Code and authenticator app safe.` (OK)
**F10. Error** · red note + `Start again`.
Verdict: the `RecoveryNeeds` box appears on F1-F5 and F7 (V34).

### 2.G Wallet recovery (`/recovery`)

Frame (all screens): [red error note] [button `Refresh` when an error occurs with a session].

**G1. Start** · 1. Heading `Recover your wallet` 2. `Enter the email linked to your account. A recovery takes a few days, and we email you when it starts.` 3. `RecoveryNeeds` box 4. `Email address` field 5. `Start recovery`. Verdict: the requirements box is relevant here and the warning is a disclosure (OK); V52 on the button.
**G2. Verify email** · 1. `Check your email` 2. `If that address belongs to a Kaada wallet, we sent a 6-digit code. It expires soon.` 3. `6-digit code` field 4. `Verify` 5. `Send a new code`. OK (the non-committal wording is right for recovery); V53.
**G3. Create credential** · 1. `Set up this device` 2. `Choose how this device will protect your wallet from now on.` 3. [`Create passkey`] 4. [`No passkey? Use a key on this device`] (or the unavailable note).
**G4. Prove factors, session lost on reload** · 1. `Prove it’s you` 2. `This page was reloaded and lost its progress.` 3. `Start again`.
**G5. Prove factors** · 1. `Prove it’s you` 2. `Your Recovery Code is checked on this device and never sent to Kaada.` 3. `Recovery Code` field 4. `Authenticator code` field 5. `Start recovery` (V52).
**G6. Waiting** · 1. `Recovery in progress` 2. `This delay protects you. The owner of the current device can cancel it from the email link we sent. You can leave and come back on this device.` 3. `Your wallet moves to this device in about` + countdown, **or** `Working…`. Same screen for `WAIT`, `SUBMITTING`, `FINALIZING`, `WAITING_FOR_PAYMENT` (V49, V50, V51).
**G7. Prove new credential** · 1. `One quick check` 2. `Confirm that this device can sign for your wallet.` 3. `Confirm with this device` (V54).
**G8. Reset PIN** · 1. `Set a new PIN` (then `Enter it again`) 2. `You’ll use it to approve payments. Your old PIN no longer works.` 3. [red note] 4. Keypad `Next` → `Save` (V55, V56).
**G9. Set up recovery again** · 1. Heading `Set up recovery again` 2. `Your old Recovery Code and authenticator app were used up. Create new ones to protect your wallet.` 3. **a second heading `Recovery setup`** (h2) then the F-screens including the `RecoveryNeeds` box (V40).
**G10. Done** · 1. `Wallet recovered` 2. `This device now controls your wallet. Your PIN, authenticator app and Recovery Code are set.` 3. `Close` (V57).
**G11. Stopped** · 1. `Recovery stopped` 2. `It was cancelled from the device or passkey that controls your wallet. Nothing changed.` 3. `Start again`.
**G12. Failed** · 1. `Recovery couldn’t continue` 2. `It can’t start right now. Try again later.` (blocked) or `Nothing was changed. You can start again.` 3. `Start again`.

### 2.H Stop a recovery (`/recovery/cancel#token`)

**H1. Invalid** · `Link not valid` / `Open the link from the recovery email exactly as it was sent. Links work once.` 
**H2. Ready** · 1. `Stop a wallet recovery` 2. `Someone asked to recover your wallet. If it wasn’t you, stop it now from the device or passkey you normally use. Stopping never moves funds.` 3. [red note] 4. `This wasn’t me. Stop it` (busy `Confirm on your device…`).
**H3. Stopped** · `Recovery stopped` / `Your wallet is unchanged. We’ll email you to confirm.`
Verdict: three sentences, all doing work (what happened, what to do, reassurance). OK. Busy label names "your device" even for a passkey (V38 pattern).

### 2.I Error screens

**I1. Render crash** · 1. `Something went wrong` 2. `If you approved something, check your chat before trying again.` 3. [`Reference: {digest}`] 4. `Reload`.
**I2. Layout crash** · 1. `Something went wrong` 2. `Kaada hit a problem loading this page. If you already approved an action, check its status in your chat before starting again{ (reference …)}.` 3. `Try again`. V61.

---

## 3. Findings

Severity: **High** misleads about money or state; **Medium** wrong or contradictory but unlikely to cause a wrong action; **Low** polish. Where a rewrite is proposed it is the shortest wording that stays true to what the code does. Nothing is applied.

| ID | Page / Context | Current text | Problem | Class | Sev | Recommendation |
|---|---|---|---|---|---|---|
| V01 | Authorize, done, after a preparation failure or a network failure | Heading `PIN verified` / `Passkey verified` over `We couldn't confirm a final price right now. Please try again shortly. Nothing was sent.` (also `EXECUTION_BLOCKED`, `FIRM_QUOTE_TOO_CLOSE_TO_EXPIRY`, `PROVIDER_CAPACITY_REACHED`, and the client error) | The heading reads as success while the note says the payment did not go out. `authorizedTitle` only maps `INSUFFICIENT_BALANCE`, `GAS_FUNDING_REQUIRED`, `EXECUTION_ROUTE_UNSUPPORTED` to "not sent". | IS | High | Rewrite: map these four states to `Payment not sent`, as is already done for the other "nothing was sent" states. For the client error (`Couldn't confirm your payment's progress…`) the proof heading can stay. |
| V02 | Authorize, done, `PAYMENT_SENT` | Heading `Payment sent` + note `Payment sent.` | The note repeats the heading word for word. | RD | Medium | Remove the note when the state is `PAYMENT_SENT`. |
| V03 | Authorize, done, `PROCESSING_PAYMENT` / `REAUTHORIZATION_REQUIRED` | `Sending payment` + `Processing your payment...`; `Authorize payment again` + `Please authorize the payment again.` | Note restates the heading. | RD | Low | Keep the heading; drop the note for these two states. |
| V04 | Authorize, done, `ROOT_ACTION_REQUIRED` | `One more step` + `One more confirmation is needed before this payment can be sent.` + link `Confirm with passkey` | Heading and note say the same thing; the link says what to do. | RD | Medium | Heading `One more confirmation`; drop the note; keep the link. |
| V05 | Authorize, done, all states | Description `You can also return to your chat.` | "also" has nothing to be "also" to. It appears even when the person must tap a link, and when execution is not running at all (503), where it suggests something is in progress. | AM | Medium | Show `You can return to your chat.` only for processing, pending and sent. Otherwise omit. |
| V06 | Bot ↔ root-action page, conversions | Bot `One more confirmation is needed before this payment can be sent.`; page for a conversion says `Confirm conversion…` | Cross-surface: the bot calls a conversion a payment; the page does not. | IC | Medium | Make the bot sentence operation-aware, or use a neutral `before this can be sent`. |
| V07 | Authorize, heading by method | `Confirm payment` (passkey, device key) vs `Authorize payment` (PIN only); tab `Authorize payment`; bot button `Authorize payment`; keypad `Confirm` | Same screen type, same task, two verbs. The difference follows the wallet type, which means nothing to the person. | IT | Medium | One verb. Proposed: heading `Confirm payment` for all three, keypad `Confirm`, tab and bot button `Confirm payment`. |
| V08 | Authorize, device-key and PIN methods | `Confirm` / `Confirming…` / `Authorize` / `Authorizing…` in `app-copy.ts` | Never displayed: the keypad replaces the button. Dead copy that suggests a different screen than the one shown. | RD | Low | Remove the unused `action`/`waiting` for those two methods, or feed the keypad's submit label from them. |
| V09 | Authorize, conversion, summary | `Recipient receives` | A conversion has no recipient (the bot says `You get`). Reachable only by direct link, so low impact. | IC | Low | `You get` when the operation is `CONVERT`. |
| V10 | Authorize, passkey footer | `Passkey not working?` + `Recover your wallet` | A cancelled prompt is not "not working", and the link leads to a multi-day wallet recovery in the middle of a payment. | AM | Medium | `Lost your passkey?` + `Recover your wallet` (parallel to `Lost this device?`). |
| V11 | Authorize, blocked, no PIN | `Create your PIN first` / `Ask Kaada in your chat for a security link.` | Does not say what to ask. The bot's `/start` is described as "pick up where you left off". | AM | Medium | `Send /start in your chat to finish setup.` |
| V12 | Authorize, blocked, reset | `Reset your PIN` / `A PIN can only be replaced through recovery. Nothing was sent.` | The heading is an instruction and the description names recovery, but no link is offered, while the footers on other screens do offer one. | AM | Medium | Add the `Recover your wallet` link; keep the description. |
| V13 | PIN failure words | `Incorrect PIN. 2 attempts left.` / `Too many attempts. Try again later.` (authorize) vs `That PIN is incorrect. Please try again.` / `Too many wrong PIN attempts. Please try again later.` (`describeError`) | Two phrasings of the same two events. The second pair looks unreachable from any current screen (verify at runtime). | IT | Low | Use the `failureCopy` set; delete the duplicates once confirmed unreachable. |
| V14 | Unknown outcome, authorize vs root-action | `Check your chat before trying again.` vs `Check your payment before trying again.` | The root-action page has no payment to check; both mean the same thing. | IT | Low | `Check your chat before trying again.` in both. |
| V15 | Link expired, all link pages | `Link expired` | Shown for expired, already-used, replaced and wrong-state links alike (root-action `resolve` rejects each the same way). After finishing, reopening the link says "expired". | IS | Medium | `This link can't be used anymore` + `Go back to your chat to continue.` |
| V16 | Link expired body | `Ask Kaada in your chat for a new payment link.` (setup: `setup link`, request: `link`, security: `security options link`) | Nobody asks for a link: the bot says `Tell me again if you still want to send it.` | AM | Medium | Payment: `Start the payment again in your chat.` Setup: `Send /start in your chat.` Drop the unused `security options` variant. |
| V17 | Loading | `Loading…` | Fine. | OK | – | Keep. |
| V18 | Root-action, ready | Heading `Confirm payment with passkey` + hint `One more confirmation to send this payment.` + button `Confirm with passkey` | Three lines, one idea. | RD | Medium | Heading `Confirm with passkey` (device: `Confirm on this device`), hint unchanged, button `Confirm`. |
| V19 | Root-action hint, payment vs conversion | `One more confirmation to send this payment.` / `One-time confirmation so Kaada can convert … without asking each time.` | One says the step repeats ("one more"), the other that it is once. Whether a payment's confirmation is reused later depends on the stored scope (`scopeKey`); verify at runtime before choosing the wording. | AM | Medium | Decide from behaviour; if reused, `Needed once to send payments like this.` Otherwise keep. |
| V20 | Root-action, done | `Passkey verified` / `Your payment continues. Follow it in your chat.` | The server only accepted the proof (202); whether the payment continues depends on something polling `/run` or the reconciler picking it up. "continues" is a promise the page cannot check. | IS | Medium | `We'll update you in your chat.` (the status dispatcher does send it). |
| V21 | Return-to-chat | `…Follow it in your chat.` (root-action) / `You can also return to your chat.` (authorize) vs setup `Wallet ready` with a `Back to Kaada` link | Same instruction, a button on one screen and none on the others. | IT | Low | Add the same `Back to Kaada` link wherever the text sends the person to the chat. |
| V22 | Cancel notes | `Cancelled. Nothing was changed.` (root-action, setup) / `Cancelled. Nothing was sent.` (authorize) / `Cancelled. Your PIN wasn't saved.` / `That was cancelled. Nothing was changed; you can try again.` | Four phrasings. In a payment, "sent" is the meaningful word. | IT | Low | Name the thing: payment → `Nothing was sent.`; setup → `Nothing was changed.` |
| V24 | Setup, device unsupported | Note `This browser can't keep a device key…` + main button `Use this device` + hint `Keep a key on this device…` | Offers the exact action the note says cannot work; and the passkey option has been removed. | CM | High | Hide the device button; restore `Create passkey`; keep the note. |
| V25 | Setup, no passkeys, device keys off | Note `This browser doesn't support passkeys…` + button `Create passkey` | Same: retry of an impossible action. | CM | High | Hide the button; keep the note. |
| V26 | Setup, other creation failures | Heading `Couldn't load setup`, note `Couldn't confirm setup. Reload before trying again.`, button `Try again` | The error is routed to the load-failure screen, so a failed creation is headed "load". The note says "Reload" while the button says "Try again". | IC | High | Heading `Setup didn't finish`; note `Couldn't confirm setup.`; button `Try again`. |
| V27 | Setup, first screen | `Secure your wallet` | The person is creating a wallet (tab `Set up your Kaada wallet`, bot `Set up Kaada`); "secure" is also the badge, the security page's name and the bot's `Secure my account` (recovery). | IT | Medium | `Set up your wallet`. |
| V28 | Setup, finish | `Almost done` / `One last step to create your wallet.` | A PIN and recovery still follow, so "last" is false. Heading and description say the same thing as the button `Finish setup`. | IS | Medium | Keep heading `Almost done`, remove the description. |
| V29 | Setup, saving the PIN | Heading `Create your PIN` + `Confirming it’s you…` | While a passkey or device prompt is open. The note does not say what to do. | AM | Medium | `Confirm with your passkey or this device…` (as in recovery setup), method-specific if known. |
| V30 | Setup/recovery PIN, second entry | `You'll use it to approve payments.` repeated under `Confirm your PIN` | Repeats a line the person just read. Recovery repeats `Your old PIN no longer works.` | RD | Low | Description on the first entry only. |
| V31 | Setup, after the PIN | `PIN saved` / `You can return to your chat.`; `Wallet ready` / `You can return to your chat.` (not funded) | Cross-surface: the bot's onboarding says a recovery step comes after the PIN; the page offers recovery only when the wallet is funded. Verify at runtime whether the bot still pushes recovery to unfunded wallets. | CM | Medium | Make both surfaces use the same condition, then keep the text. |
| V32 | Setup, `Wallet ready` | Description `You can return to your chat.` + link `Back to Kaada` | The description restates the link. | RD | Low | Remove the description. |
| V33 | Setup, footer | `Kaada never sees your passkey or key.` | A security disclosure at the moment of enrollment. | OK | – | Keep. |
| V34 | Recovery setup, `RecoveryNeeds` | Five-line box on the email, authenticator, intro and confirm steps (and again inside `Set up recovery again`) | The same block four to five times in one flow, including the step where the person is typing the code back. | EX | Medium | Show the full box once (first step); at the Recovery Code intro show only the warning line; remove it from the other steps. |
| V35 | Recovery setup, email | Sub-heading `1. Recovery email` | A number with no 2 or 3 anywhere. | IT | Low | Remove the number. |
| V36 | Recovery setup, email code | `If that address can be used, a 6-digit code is on its way to {email}. It expires in 10 minutes.` | The "if it can be used" wording protects recovery from probing; here the person is adding their own address. Also `10 minutes` here vs `soon` on the recovery page. | IC | Medium | `We sent a 6-digit code to {email}. It expires in 10 minutes.` |
| V38 | Recovery setup, arming; cancel busy label | `Confirm with your passkey or this device…`; `Confirm on your device…` | Lists both when the method is known; "device" for a passkey user. | AM | Low | Use the method-specific wording from the confirmation steps. |
| V40 | Recovery, `Set up recovery again` | Heading `Set up recovery again` then heading `Recovery setup` | Two stacked headings for one step. | RD | Low | Drop the inner heading when nested. |
| V42 | Security, done and setup warning | `Your new credential controls your wallet…`, `Your credential is saved.` | "credential" appears only here; every other screen says passkey, device or key. | IT | Low | `passkey or device`. |
| V43 | Security, done | `Done. Your new credential controls your wallet and the old one no longer works.` | `Done.` repeats the green status. Long. | EX | Low | `The old one no longer works.` (rotate); `Backup added.` (backup). |
| V44 | Security, "Check status" result | `Change confirmed.` | After a normal finish the message is specific; after a manual check it loses which change and drops "the old one no longer works". | AM | Low | Keep the change kind in the pending state and reuse the specific message. |
| V45 | Security menu | `Wallet security` / `Choose what to update.` | Fine. | OK | – | Keep. |
| V48 | Security, invalid link | (no screen) | No loading or expired screen; the first failure appears after an action as `This link or session has expired. Start again.` | AM | Low | Acceptable; at least `Ask Kaada…` wording should match V16. |
| V49 | Recovery, waiting screen | `This delay protects you…` for `WAIT`, `SUBMITTING`, `FINALIZING`, `WAITING_FOR_PAYMENT` | A safety delay is explained for steps that are not a delay. What `WAITING_FOR_PAYMENT` means to the person is not stated anywhere (verify at runtime). | IC | Medium | Delay text only for `WAIT`; other states `Working…` plus a state-specific line once their meaning is confirmed. |
| V50 | Recovery, waiting description | Three sentences | Two ideas (why, who can stop it) plus a reminder. | EX | Low | `This delay protects you. Whoever holds your current device can stop it from the email we sent. You can leave and come back on this device.` |
| V51 | Recovery countdown | `about 0h 0m` | At zero the page says "about 0h 0m". | AM | Low | `Finishing…` at zero. |
| V52 | Recovery, two `Start recovery` buttons | G1 `Start recovery` (sends an email code) and G5 `Start recovery` (starts the delay) | One label, two different steps. | AM | Medium | G1 `Send code` (as in setup), G5 `Start recovery`. |
| V53 | Recovery email | `Verify` vs setup `Verify email` | Same step, two labels. | IT | Low | `Verify email`. |
| V54 | Recovery, new credential | `One quick check` / `Confirm that this device can sign for your wallet.` / `Confirm with this device` | "sign" is jargon and the heading says nothing; the button already says what to do. | AM | Low | Heading `Confirm this device`; remove the description. |
| V55 | Recovery PIN reset | `Enter it again` | A heading with no noun; setup says `Confirm your PIN`. | IT | Low | `Confirm your new PIN`. |
| V57 | Recovery, done | Button `Close` | `forget` clears the stored session and the screen returns to the recovery start form (`use-recovery.ts:265-273`). "Close" does not close anything. | AM | Medium | `Back to Kaada` (Telegram link), as in setup. |
| V58 | Recovery, done description | `This device now controls your wallet. Your PIN, authenticator app and Recovery Code are set.` | Confirms real outcomes. | OK | – | Keep. |
| V59 | Cancel page | Three-sentence description | Each sentence carries something distinct. | OK | – | Keep. |
| V61 | Crash screens | `Reload` / `If you approved something, check your chat before trying again.` vs `Try again` / longer sentence | Same event, two wordings. | IT | Low | Use the first wording in both; keep the reference. |
| V62 | Home heading | `Your Kaada wallet` | The page is a pointer to Telegram, not a wallet view. | AM | Low | Acceptable; optionally `Kaada`. |
| V63 | `describeError` gas messages | `To finish securing your account, add a small amount of CELO to your wallet.` | "securing your account" is a third word for wallet setup; elsewhere `failureCopy.gasFunding` says `Your wallet needs CELO for the network fee.` | IT | Low | `Your wallet needs a little CELO for the network fee.` |
| V64 | `describeError` | `Create your payment PIN before continuing.` | "payment PIN"; every other screen says "PIN". | IT | Low | `Create your PIN first.` |
| V65 | Link subject `security` | `security options link` | Declared but no page uses it. | RD | Low | Remove the variant. |
| V67 | Authorize, done, `NOT_STARTED` right after `EXECUTION_READY` | `Payment authorized and final pricing confirmed.` then `Your payment isn't ready yet.` | If the status call returns `NOT_STARTED` first, the second line contradicts the first. Verify at runtime. | CM | Medium | Do not show `Your payment isn't ready yet.` once preparation has reported ready; treat `NOT_STARTED` after ready as `Processing…`. |
| V68 | Authorize, done, `PAYMENT_FAILED` | Heading `Payment failed` + `The payment didn't go through. Please check your wallet and try again.` vs bot `The payment didn't go through, and your funds are safe.` and web `The payment wasn't sent. Start it again from your chat.` | Three different instructions: check your wallet, start again from chat, nothing. There is no retry action on the page. | CM | Medium | `The payment didn't go through. Start it again from your chat.` |

IDs are not contiguous: the gaps (V23, V37, V39, V41, V46, V47, V56, V60, V66) are unused numbers, not missing findings.

---

## 4. Lifecycle per operation

For each operation, every screen in order and whether the words stay true to it.

| Operation | Screens in order | Holds together? |
|---|---|---|
| **Wallet setup** | tab `Set up your Kaada wallet` → B4 `Secure your wallet` → B9 `Almost done` → B10-B15 PIN → B16 `Wallet ready` | Mostly. The first heading names the wrong operation (V27), `One last step` is false (V28), and a failure is drawn as a load error (V26). |
| **Passkey enrollment** | B4-B8 (setup); G3 `Set up this device` (recovery); E2/E3 buttons (security) | Three different headings for the same act: `Secure your wallet`, `Set up this device`, `Use a new passkey`/`Add a passkey`. Acceptable because the reason differs, but the unsupported-browser branches contradict themselves (V24, V25). |
| **Passkey verification** (to approve something) | C4 `Confirm payment`/`Confirm with passkey`; D4 `Confirm payment with passkey`; G7 `Confirm with this device`; F8 arming | Consistent wording of the button; two payment screens in a row both ask for the passkey with similar headings (V18). |
| **PIN creation** | B10-B15; G8 | Same words; recovery's second heading differs (V55). |
| **PIN verification** | C5/C6, keypad | Heading differs by wallet type only (V07). |
| **Payment authorization** | C4-C7 → C11 first rows | `PIN verified` then the server's statuses. Correct unless a preparation failure occurs (V01). |
| **Payment submission** | C11 `Sending payment` | Heading and note repeat (V03). |
| **Payment confirmation** | C11 `Payment sent` | Repeats (V02). The note under `PAYMENT_PENDING` is accurate and kept. |
| **Conversion authorization / confirmation** | Bot `✅ Confirm`, then D6/D8 if the extra step is needed | Page and bot disagree on the noun (V06). The web authorize screens for a conversion are practically unreachable (C8). |
| **Wallet security** | E1 → E2/E3 → E4 → E5/E6/E7 | Accurate step-by-step text (E4 is the best example in the app). "credential" (V42) and the generic confirmed line (V44) are the gaps. |
| **Wallet recovery** | G1 → G2 → G3 → G5 → G6 → G7 → G8 → G9 → G10 | Reads well except V49 (waiting copy reused for non-delay states), V52 (two identical buttons), V57 (`Close`). |

---

## 5. Terminology check

| Concept | Words in use | Recommended single word |
|---|---|---|
| Proving it is you | `Confirm`, `Authorize`, `Approve` (bot and docs), `Verify`, `Prove it’s you` | Payment: **Confirm**. Recovery factors: keep `Prove it’s you`. Email/code: **Verify**. |
| A passkey / device key | `passkey`, `device`, `device key`, `key`, `credential`, `root` (docs only) | `passkey` and `device`; avoid `credential` and never show `root`. |
| The thing being created | `wallet`, `account`, `Kaada` | `wallet` for the thing; `account` only where the product means the Kaada account (bot's country question). |
| Outcome of authorization | `verified` (new), `approved` (removed), `authorized` (server/bot), `confirmed` | `verified` for the proof; `sent` only for the payment. |
| Retry after failure | `Try again`, `Start again`, `Reload`, `Refresh` | `Try again` for repeating the same step; `Start again` only when progress is lost. |
| Where to go next | `your chat`, `Telegram`, `Kaada` | `your chat` in text, `Back to Kaada` on the link. |

---

## 6. Corrections to the inventory and what could not be verified

Corrections:
1. The inventory said the first cases of `preparationMessage` were not read. They have now been read: `EXECUTION_READY` is the first case, and the full set of preparation states is the one listed in C11. No new state was found.
2. The inventory said the conversion `Authorize` screens exist. They exist in code but the bot never sends a link for conversions (it confirms in chat), so they are reachable only by direct link (C8).
3. In the inventory's setup table, "Failure: any other passkey error" is drawn by the load-failed screen; this report treats that as V26.

Not verifiable from code (needs a run):
- V19: whether a payment's root confirmation repeats or is reused.
- V20: whether a payment resumes if the authorize page was closed before the root step.
- V31: whether the bot's onboarding still prompts for recovery on an unfunded wallet.
- V49: what `WAITING_FOR_PAYMENT` means to the person.
- V67: whether `NOT_STARTED` can follow `EXECUTION_READY` in practice.
- V13: whether `describeError`'s PIN codes can reach any screen.

Not reviewed (out of scope): landing page, legal pages, the dev playground, bot text that is never shown inside the application.

---

## 7. Implementation status

The findings above were implemented after review. This section records what happened to each. Sections 1 to 6 describe the application **before** the change and are kept as the record of the audit.

### Resolved

| Findings | What was done | Where |
|---|---|---|
| V01-V05, V67, V68 | The payment done screen is a pure view of the server's state (`paymentProgressCopy`, `PaymentProgressView`). The heading follows the payment: `Payment not sent` for the four preparation failures (with `Your PIN was verified, but …` and the server's own `Nothing was sent.`), `Payment status unavailable` for an unreadable status (no claim either way), `Payment failed` only for a definitive failure. `Payment sent` stands alone. No line repeats another. The server's `NOT_STARTED` no longer replaces a confirmed price (`advanceOutcome`: a final state is never replaced, and "not started" never follows "ready"). | `lib/app-copy.ts`, `authorize/[token]/final-pricing.tsx`, `follow-payment.ts`, `use-payment-progress.ts` |
| V06, V09 | The conversion's words never mention a payment or a recipient (`You get`, `Confirm conversion`). The bot's root-step sentence is neutral and shared with the page's constant. | `payment-summary.tsx`, `runner.ts` (`ROOT_ACTION_NOTICE`) |
| V07, V08 | One verb: `Confirm payment` / `Confirm conversion` for every method, on the page tab and on the bot button. The keypad's key takes its label from the same copy; unused busy labels removed. | `app-copy.ts`, `authorize-flow.tsx`, `message-service.ts` |
| V10-V12 | Footers: `Can't use your passkey?` / `Can't use this device?` + `Recover your wallet`. Missing PIN: `Send /start in your chat to finish setup.` Reset required: the recovery link is now on the screen. | `authorize-flow.tsx`, `app-copy.ts` |
| V13, V14, V22, V63, V64 | PIN, cancellation and unknown-result wording come from `failureCopy` in both `describeError` and the screens. `Check your chat` everywhere. Gas wording no longer says "securing your account". | `app-copy.ts`, `lib/api.ts` |
| V15, V16 | One neutral `This link is no longer available` plus the way the bot continues (`Start the payment again in your chat.`, `Send /start in your chat to continue.`, `Return to your chat to continue.`). Unused `security` variant removed. | `app-copy.ts`, `flow-status.tsx` |
| V18-V20 | Root-action screen: heading `Confirm payment`, one supporting line, action `Use passkey` / `Continue on this device`. Done: `Passkey verified` / `Device verified` + `We'll update you in your chat.` | `app-copy.ts`, `root-action-flow.tsx`, `root-action-service.ts` |
| V24-V26 | The setup screen offers only what this browser can do (`SetupCredentialView`). A browser that can do neither gets the explanation and no action. A failure that happened before anything was sent keeps the same action; a failure after the request went out shows `Setup not confirmed` with only `Check again` (it re-reads the wallet's state, so no second passkey or key is created). | `setup-credential-step.tsx`, `setup-unconfirmed-step.tsx`, `use-setup.ts`, `setup-flow.tsx` |
| V27-V30, V32 | `Set up your wallet`. `Almost done` has no false "last step" and the button is `Create wallet`. PIN: description on the first entry only; the saving state is `Verify it's you` with the prompt the server chose; a failure before the PIN was sent retries, one after shows `Check again`. `Wallet ready` has no repeated line. | `setup/[token]/*`, `app-copy.ts` (`rootPromptCopy`) |
| V34-V36, V38, V40 | The requirements box is shown once (first step); the Recovery Code step shows only the loss warning; the numbering is gone; a nested recovery setup has no second heading; the root prompt is method-specific. The hedged email wording is kept (not shown to be safe to change); the expiry is stated once (`EMAIL_CODE_MINUTES`, the policy default of 10 minutes). | `recovery-needs.tsx`, `recovery-code-*.tsx`, `recovery-email-step.tsx`, `recovery-copy.ts` |
| V42-V44 | `passkey` / `device key`, never `credential`. Which change is being confirmed travels with the pending state, so `Check status` ends on the same specific sentence. | `use-security.ts`, `security-actions.ts`, `security-progress.tsx` |
| V49-V55, V57 | The waiting screen says what is actually happening for each server step (safety delay, starting, finishing, waiting for a payment in flight). At zero: `The delay is over. Finishing recovery…`. `Send code` vs `Start recovery`; `Verify email`; the new-device step is named for its method; `Confirm your new PIN`; `Back to Kaada` is now a real link and also clears the finished recovery. | `recovery/*`, `recovery-copy.ts` |
| V61, V62 | Both crash screens use `errorCopy` (with the reference). The home heading is `Kaada`. | `app-copy.ts`, `application-failure.tsx`, `global-error.tsx`, `application-home.tsx` |

### Retained on purpose

| Finding | Why |
|---|---|
| V17, V33, V45, V58, V59 | Already appropriate. |
| V21 | No "back to chat" link was added to the payment and extra-check screens: the updates arrive in the chat the person came from, and a link would suggest leaving. `Wallet ready` and recovery completion, which end the flow, do link. |
| V36 | The `If that address can be used…` hedge stays: enrollment's endpoints were not shown to be free of address probing. |
| V48 | The security page still has no upfront validity check (there is no read-only endpoint for its token); an unusable link now shows the same `This link is no longer available.` after the first action. |
| V50 | Kept at three sentences (why, who can stop it, that the person can leave); the wording was tightened. |

### Verified rather than assumed

- **V20:** the payment does resume after the extra security check. `ExecutionReconciler` runs the runner on every active execution, including `REQUIRES_USER_ACTION`, on a timer. So `We'll update you in your chat.` is accurate (it still depends on the firm quote being valid when the runner resumes).
- **V31:** the bot and the page agree. Both ask for recovery only when the wallet has been funded (`deriveOnboarding` and the setup endpoint both use `hasBeenFunded`; the policy flag `requireRecovery` defaults to true).
- **V49:** `WAITING_FOR_PAYMENT` means the recovery was held back because a payment from the old wallet is still in flight (`PAYMENT_IN_FLIGHT`, set by the recovery finalizer).
- **V19:** whether the permission a payment's extra check installs is reused depends on its scope, so the wording no longer says "one-time".
- **PIN length:** the transaction PIN is **six** digits in the code (`PIN_LENGTH = 6`, `^[0-9]{6}$`, and the bot says "6-digit PIN"). It was not changed: it is a security setting, and the brief's "four digits" does not match the implementation. If four is the product requirement, that is a separate change to the domain package, the keypad, the bot text and existing PINs.

### Not verified end to end

- No browser was available (the Chrome extension was not connected and no headless browser is installed), so the pages were **not** driven in a real browser. Screens were verified by rendering them with their real components and states (`apps/web/app/screens.test.ts`, `authorize/[token]/payment-progress.test.ts`).
- The API integration suite could not run: it needs a database and timed out connecting.
- Not exercised against a real passkey, device key, Telegram chat or payment provider.
