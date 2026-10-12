import { z } from "zod";

import type { RootProof } from "@kaada/domain";

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

/** The only shapes a root's proof may take on the wire. Everything else is refused before a service sees it. */
export const rootProofSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("PASSKEY"),
    assertion: z.looseObject({
      id: z.string().min(1).max(1024),
      rawId: z.string().min(1).max(1024),
      type: z.literal("public-key"),
      response: z.looseObject({
        clientDataJSON: z.string().min(1).max(8192),
        authenticatorData: z.string().min(1).max(8192),
        signature: z.string().min(1).max(8192),
      }),
    }),
  }),
  z.strictObject({
    type: z.literal("DEVICE_KEY"),
    keyId: z.string().regex(/^0x[0-9a-f]{64}$/),
    r: hex64,
    s: hex64,
    challenge: z
      .string()
      .regex(/^0x[0-9a-f]{64}$/)
      .optional(),
  }),
]);

export function parseRootProof(value: unknown): RootProof | null {
  const parsed = rootProofSchema.safeParse(value);
  return parsed.success ? (parsed.data as RootProof) : null;
}
