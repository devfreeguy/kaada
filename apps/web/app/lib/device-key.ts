/*
 * A device key: a P-256 key pair made by the browser's WebCrypto. The PRIVATE key is generated NON-EXTRACTABLE and only ever
 * used to sign; it is kept as an opaque CryptoKey in IndexedDB, so page script can ask it to sign but can never read its bytes.
 * Kaada receives the public coordinates and signatures only. This is the web tier (WEB_NON_EXTRACTABLE): a browser keystore is
 * not attested hardware, so the server never calls it trusted.
 *
 * Everything here is plain WebCrypto and BigInt: it runs unchanged in a browser and in Node (for tests).
 */

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const P256_HALF_N = P256_N / 2n;

const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

export interface DeviceKeyMaterial {
  /** 64 lower-case hex characters each (no 0x). */
  publicKeyX: string;
  publicKeyY: string;
  /** Opaque and non-extractable: it can sign, nothing can read it. */
  privateKey: CryptoKey;
}

export interface DeviceSignature {
  /** 32-byte big-endian integers, 64 lower-case hex characters each (no 0x). `s` is low-s. */
  r: string;
  s: string;
}

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) throw new Error("malformed hex");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

const pad32 = (value: bigint): string => value.toString(16).padStart(64, "0");

/** Whether this browser can make and keep a device key (WebCrypto and IndexedDB). */
export function deviceKeySupported(): boolean {
  return (
    typeof globalThis.crypto?.subtle === "object" &&
    typeof (globalThis as { indexedDB?: unknown }).indexedDB === "object"
  );
}

/** A fresh P-256 key pair whose private half cannot be exported. */
export async function generateDeviceKey(
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<DeviceKeyMaterial> {
  const pair = await subtle.generateKey(ECDSA, false, ["sign", "verify"]);
  // The public key is always exportable, whatever the private key's flag says.
  const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  if (raw.length !== 65 || raw[0] !== 4) throw new Error("unexpected public key encoding");
  return {
    publicKeyX: toHex(raw.slice(1, 33)),
    publicKeyY: toHex(raw.slice(33, 65)),
    privateKey: pair.privateKey,
  };
}

/** Signs exactly `payloadHex` (ECDSA P-256 over SHA-256 of the bytes) and returns r and a LOW-s s. */
export async function signDevicePayload(
  privateKey: CryptoKey,
  payloadHex: string,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<DeviceSignature> {
  const signature = new Uint8Array(await subtle.sign(SIGN, privateKey, fromHex(payloadHex)));
  if (signature.length !== 64) throw new Error("unexpected signature encoding");
  const r = BigInt(`0x${toHex(signature.slice(0, 32))}`);
  let s = BigInt(`0x${toHex(signature.slice(32, 64))}`);
  // WebCrypto may return either s or n - s; the validator accepts only the low one.
  if (s > P256_HALF_N) s = P256_N - s;
  return { r: pad32(r), s: pad32(s) };
}

// ─────────────────────────────── storage (IndexedDB) ───────────────────────────────

const DB_NAME = "kaada-device-keys";
const STORE = "keys";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("storage unavailable"));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = work(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("storage failed"));
    });
  } finally {
    db.close();
  }
}

/** Remembers the private key (as an opaque CryptoKey) under the key id the server derived. */
export async function saveDeviceKey(keyId: string, privateKey: CryptoKey): Promise<void> {
  await withStore("readwrite", (store) => store.put(privateKey, keyId));
}

/** The private key for `keyId`, or null when this browser does not hold it. */
export async function loadDeviceKey(keyId: string): Promise<CryptoKey | null> {
  const found = await withStore<unknown>("readonly", (store) => store.get(keyId));
  return typeof CryptoKey !== "undefined" && found instanceof CryptoKey ? found : null;
}
