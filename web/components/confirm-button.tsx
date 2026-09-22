"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Asks for the same click twice instead of opening a browser dialog: the first click turns the
 * button into the confirmation, which goes back to its label if it is left alone.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  disabled,
  small,
  ariaLabel,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
  small?: boolean;
  ariaLabel?: string;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  function click() {
    if (timer.current) clearTimeout(timer.current);
    if (armed) {
      setArmed(false);
      onConfirm();
      return;
    }
    setArmed(true);
    timer.current = setTimeout(() => setArmed(false), 4_000);
  }

  return (
    <button
      type="button"
      className="button"
      data-variant={armed ? "danger" : "quiet"}
      data-size={small ? "small" : undefined}
      disabled={disabled}
      onClick={click}
      onBlur={() => setArmed(false)}
      aria-label={ariaLabel}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}
