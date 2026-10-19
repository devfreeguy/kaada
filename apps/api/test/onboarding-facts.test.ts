import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Identity, Wallet } from "@kaada/domain";

import { createOnboardingStateReader } from "../src/core/onboarding/facts-reader.js";
import { deriveOnboarding } from "../src/core/onboarding/state.js";

/*
 * Recovery counts as set up only when it could really start: a verified email AND an armed Recovery Code. Either alone protects
 * nothing (recovery starts from the email; the code is what proves it), so neither may tell a person they are done.
 */

const USER = "user-1";
const wallet = { id: "w1", status: "ACTIVE", address: `0x${"ab".repeat(20)}` } as unknown as Wallet;
const email = { type: "EMAIL", externalId: "a@example.com" } as unknown as Identity;
const telegram = { type: "TELEGRAM", externalId: "42" } as unknown as Identity;

function reader(
  options: {
    wallet?: Wallet | null;
    pin?: boolean;
    identities?: Identity[];
    armed?: boolean;
    enabled?: boolean;
  } = {},
) {
  return createOnboardingStateReader({
    wallets: {
      findEmbedded: () => Promise.resolve(options.wallet === undefined ? wallet : options.wallet),
    },
    transactionPins: {
      findByUserId: () => Promise.resolve(options.pin === false ? null : ({} as never)),
    },
    identities: { listForUser: () => Promise.resolve(options.identities ?? [telegram]) },
    recoveryConfigurations: {
      findActive: () => Promise.resolve(options.armed ? ({} as never) : null),
    },
    recoveryEnabled: options.enabled ?? true,
  });
}

describe("what 'recovery is set up' means", () => {
  it("needs BOTH a verified email and an armed Recovery Code", async () => {
    assert.equal(
      (await reader({ identities: [telegram, email], armed: true }).read(USER)).recoveryConfigured,
      true,
    );
    assert.equal(
      (await reader({ identities: [telegram], armed: true }).read(USER)).recoveryConfigured,
      false,
      "a code with no email cannot start a recovery",
    );
    assert.equal(
      (await reader({ identities: [telegram, email], armed: false }).read(USER)).recoveryConfigured,
      false,
      "an email with no code proves nothing",
    );
    assert.equal((await reader({ identities: [telegram] }).read(USER)).recoveryConfigured, false);
  });

  it("does not apply where this deployment has no recovery", async () => {
    assert.equal((await reader({ enabled: false }).read(USER)).recoveryConfigured, null);
  });

  it("a person with no wallet yet is not 'recovery configured'", async () => {
    assert.equal((await reader({ wallet: null }).read(USER)).recoveryConfigured, false);
  });

  it("with recovery required, a wallet and a PIN are not enough: the step is RECOVERY until both halves exist", async () => {
    const policy = { requireRecovery: true };
    const none = await reader({ identities: [telegram] }).read(USER);
    assert.equal(deriveOnboarding(none, policy).step, "RECOVERY");
    const emailOnly = await reader({ identities: [telegram, email] }).read(USER);
    assert.equal(deriveOnboarding(emailOnly, policy).step, "RECOVERY");
    const done = await reader({ identities: [telegram, email], armed: true }).read(USER);
    assert.equal(deriveOnboarding(done, policy).step, "COMPLETE");
  });

  it("without a PIN the PIN step still comes first", async () => {
    const facts = await reader({ pin: false }).read(USER);
    assert.equal(deriveOnboarding(facts, { requireRecovery: true }).step, "PIN");
  });
});
