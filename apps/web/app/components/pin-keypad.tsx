"use client";

/*
 * A numeric keypad for the 4-digit PIN. There is deliberately NO <input>: the digits live only in the
 * parent component's memory (never in the URL, local/session storage, a cookie, an autofill field or a
 * form), and the parent clears them the moment they are submitted.
 */

export const PIN_LENGTH = 4;

interface PinKeypadProps {
  value: string;
  onChange(next: string): void;
  onSubmit(): void;
  disabled?: boolean;
  submitLabel?: string;
}

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

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
  const base =
    "flex h-16 items-center justify-center rounded-2xl text-2xl font-medium select-none disabled:opacity-40";

  return (
    <div className="flex flex-col items-center gap-6">
      <div
        role="img"
        aria-label={`${value.length} of ${PIN_LENGTH} digits entered`}
        className="flex gap-4"
      >
        {Array.from({ length: PIN_LENGTH }, (_, index) => (
          <span
            key={index}
            className={`h-4 w-4 rounded-full border-2 border-neutral-900 ${index < value.length ? "bg-neutral-900" : "bg-transparent"}`}
          />
        ))}
      </div>

      <div className="grid w-full max-w-xs grid-cols-3 gap-3">
        {DIGITS.map((digit) => (
          <button
            key={digit}
            type="button"
            disabled={disabled}
            onClick={() => press(digit)}
            className={`${base} bg-neutral-100 active:bg-neutral-200`}
          >
            {digit}
          </button>
        ))}
        <button
          type="button"
          aria-label="Delete"
          disabled={disabled || value.length === 0}
          onClick={() => onChange(value.slice(0, -1))}
          className={`${base} bg-neutral-100 active:bg-neutral-200`}
        >
          ⌫
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => press("0")}
          className={`${base} bg-neutral-100 active:bg-neutral-200`}
        >
          0
        </button>
        <button
          type="button"
          disabled={disabled || value.length !== PIN_LENGTH}
          onClick={onSubmit}
          className={`${base} bg-neutral-900 text-white`}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
