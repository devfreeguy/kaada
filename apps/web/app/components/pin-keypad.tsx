"use client";

/*
 * A numeric keypad for the 6-digit PIN. There is deliberately NO <input>: the digits live only in the
 * parent component's memory (never in the URL, local/session storage, a cookie, an autofill field or a
 * form), and the parent clears them the moment they are submitted.
 */

export const PIN_LENGTH = 6;

interface PinKeypadProps {
  value: string;
  onChange(next: string): void;
  onSubmit(): void;
  disabled?: boolean;
  submitLabel?: string;
}

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

const KEY =
  "flex h-14 items-center justify-center rounded-xl text-xl font-medium select-none transition-colors disabled:opacity-40";
const QUIET_KEY = `${KEY} bg-app-surface-2 text-app-text hover:bg-app-surface-3 active:bg-app-surface-3`;

export function PinKeypad({
  value,
  onChange,
  onSubmit,
  disabled = false,
  submitLabel = "Go",
}: PinKeypadProps) {
  const press = (digit: string) => {
    if (!disabled && value.length < PIN_LENGTH) onChange(value + digit);
  };

  return (
    <div className="flex flex-col items-center gap-5">
      <div
        role="img"
        aria-label={`${value.length} of ${PIN_LENGTH} digits entered`}
        className="flex gap-3.5"
      >
        {Array.from({ length: PIN_LENGTH }, (_, index) => (
          <span
            key={index}
            className={`h-3.5 w-3.5 rounded-full border-2 transition-colors ${index < value.length ? "border-app-text bg-app-text" : "border-app-border-strong bg-transparent"}`}
          />
        ))}
      </div>

      <div className="grid w-full max-w-xs grid-cols-3 gap-2.5">
        {DIGITS.map((digit) => (
          <button
            key={digit}
            type="button"
            disabled={disabled}
            onClick={() => press(digit)}
            className={QUIET_KEY}
          >
            {digit}
          </button>
        ))}
        <button
          type="button"
          aria-label="Delete"
          disabled={disabled || value.length === 0}
          onClick={() => onChange(value.slice(0, -1))}
          className={QUIET_KEY}
        >
          ⌫
        </button>
        <button type="button" disabled={disabled} onClick={() => press("0")} className={QUIET_KEY}>
          0
        </button>
        <button
          type="button"
          disabled={disabled || value.length !== PIN_LENGTH}
          onClick={onSubmit}
          className={`${KEY} bg-app-primary text-app-on-primary hover:bg-app-primary-hover`}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
