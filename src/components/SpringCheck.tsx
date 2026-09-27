import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import './SpringCheck.css';

interface SpringCheckProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  describedBy?: string;
}

export function SpringCheck({
  checked,
  onChange,
  children,
  disabled = false,
  required = false,
  className = '',
  describedBy,
}: SpringCheckProps) {
  return (
    <label className={`spring-check ${className}`.trim()}>
      <input
        type="checkbox"
        className="spring-check__native"
        checked={checked}
        disabled={disabled}
        required={required}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="spring-check__box" aria-hidden="true"><Check size={14} strokeWidth={2.8} /></span>
      <span className="spring-check__label">{children}</span>
    </label>
  );
}
