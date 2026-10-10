/**
 * A value that must never be printed, logged, serialized or returned: a provider claim token, for
 * example. It wraps the string in a private field, so JSON.stringify, template strings, util.inspect,
 * spreads and object dumps all show "[REDACTED]". The only way out is the explicit `reveal()`, which a
 * reviewer can grep for.
 */
export class SecretValue {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The secret itself. Call only to encrypt it or to hand it to the provider that issued it. */
  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return "[REDACTED]";
  }

  toString(): string {
    return "[REDACTED]";
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "[REDACTED]";
  }
}
