import { useRef, type KeyboardEvent } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import './RubberSegment.css';

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

interface RubberSegmentProps<T extends string> {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  labelledBy: string;
  disabled?: boolean;
}

export function RubberSegment<T extends string>({
  options,
  value,
  onChange,
  labelledBy,
  disabled = false,
}: RubberSegmentProps<T>) {
  const reduceMotion = useReducedMotion();
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));

  const moveTo = (index: number) => {
    if (options.length === 0 || disabled) return;
    const nextIndex = (index + options.length) % options.length;
    onChange(options[nextIndex].value);
    buttons.current[nextIndex]?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (disabled) return;
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % options.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (index - 1 + options.length) % options.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = options.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    moveTo(nextIndex);
  };

  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-disabled={disabled || undefined}
      className="rubber-segment"
      data-disabled={disabled ? '' : undefined}
    >
      <motion.span
        aria-hidden="true"
        className="rubber-segment__thumb"
        style={{ gridColumn: selectedIndex + 1, gridRow: 1 }}
        layout="position"
        transition={reduceMotion ? { duration: 0.01 } : { type: 'spring', duration: 0.24, bounce: 0.12 }}
      />
      {options.map((option, index) => (
        <button
          key={option.value}
          ref={(element) => { buttons.current[index] = element; }}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          aria-label={option.label}
          tabIndex={index === selectedIndex ? 0 : -1}
          disabled={disabled}
          className="rubber-segment__option"
          style={{ gridColumn: index + 1, gridRow: 1 }}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => handleKeyDown(event, index)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
