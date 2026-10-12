import { z } from "zod";

const base64 = (max: number) =>
  z
    .string()
    .min(4)
    .max(max)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/);

/**
 * Platform evidence from a NATIVE client. Strict on purpose: unknown fields (a client-supplied "tier", "hardwareBacked"...)
 * are refused, not ignored. It is a claim until DeviceTierService verifies it.
 */
export const attestationEvidenceSchema = z.discriminatedUnion("platform", [
  z.strictObject({
    platform: z.literal("ANDROID"),
    challengeId: z.uuid(),
    certificateChain: z.array(base64(8192)).min(2).max(6),
  }),
  z.strictObject({
    platform: z.literal("IOS"),
    challengeId: z.uuid(),
    attestationObject: base64(65536),
    keyId: base64(128),
  }),
]);

export const attestationChallengeSchema = z.strictObject({ platform: z.enum(["ANDROID", "IOS"]) });

export function challengeView(challenge: {
  challengeId: string;
  platform: string;
  nonce: string;
  expiresAt: Date;
}) {
  return {
    challengeId: challenge.challengeId,
    platform: challenge.platform,
    nonce: challenge.nonce,
    expiresAt: challenge.expiresAt.toISOString(),
  };
}
