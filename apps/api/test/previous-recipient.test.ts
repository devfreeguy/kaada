import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createHarness, intent } from "./support/harness.js";

/*
 * "Send him 0.3 CELO" right after paying someone: "him" is that person, not a stranger and not a new question. With nobody to
 * point at, it is asked about instead.
 */

const SEND_FIRST = "send 100 naira to @kryptonite_bk";
const SEND_HIM = "send him 0.3 CELO";

const first = intent({
  type: "SEND",
  recipient: { type: "USERNAME", value: "@kryptonite_bk" },
  amount: { value: "100", currencyOrAsset: "NGN" },
} as never);

const him = (value: string) =>
  intent({
    type: "SEND",
    recipient: { type: "USERNAME", value },
    amount: { value: "0.3", currencyOrAsset: "CELO" },
  } as never);

const latestConversation = (h: ReturnType<typeof createHarness>) =>
  [...h.world.conversations.values()][0]?.id ?? "";

async function latestSend(h: ReturnType<typeof createHarness>) {
  const [latest] = await h.world.repositories.intents.listRecentByConversation(
    latestConversation(h),
    1,
  );
  return latest;
}

describe("a pronoun means the person this chat was just paying", () => {
  for (const word of ["him", "her", "them", "the same person"]) {
    it(`'${word}' becomes the previous recipient`, async () => {
      const h = createHarness({ now: () => new Date(Date.UTC(2026, 0, 1, 1)) });
      h.script.set(SEND_FIRST, first);
      h.script.set(SEND_HIM, him(word));
      await h.say(SEND_FIRST);
      await h.world.repositories.intents.update((await latestSend(h))?.id ?? "", {
        status: "CANCELLED",
      } as never);
      await h.say(SEND_HIM);
      const latest = await latestSend(h);
      const parsed = latest?.parsed;
      assert.equal(parsed?.type, "SEND");
      assert.deepEqual(parsed?.type === "SEND" && parsed.recipient, {
        type: "USERNAME",
        value: "@kryptonite_bk",
      });
    });
  }

  it("with nobody earlier in the chat, it is not turned into a stranger: the recipient is asked for", async () => {
    const h = createHarness({ now: () => new Date(Date.UTC(2026, 0, 1, 1)) });
    h.script.set(SEND_HIM, him("him"));
    await h.say(SEND_HIM);
    const latest = await latestSend(h);
    const parsed = latest?.parsed;
    assert.equal(parsed?.type === "SEND" && parsed.recipient, undefined);
    assert.ok(latest?.missingFields.includes("RECIPIENT"));
  });

  it("a real name is left alone", async () => {
    const h = createHarness({ now: () => new Date(Date.UTC(2026, 0, 1, 1)) });
    h.script.set(SEND_FIRST, first);
    h.script.set("send maria 3", him("Maria"));
    await h.say(SEND_FIRST);
    await h.say("send maria 3");
    const latest = await latestSend(h);
    const parsed = latest?.parsed;
    assert.equal(parsed?.type === "SEND" && parsed.recipient?.value, "Maria");
  });
});
