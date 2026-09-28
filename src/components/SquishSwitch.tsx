import { useId } from 'react';
import './SquishSwitch.css';

interface SquishSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description: string;
  disabled?: boolean;
}

export function SquishSwitch({ checked, onChange, label, description, disabled = false }: SquishSwitchProps) {
  const descriptionId = useId();

  return (
    <label className="squish-switch-card">
      <span className="squish-switch-card__copy">
        <strong>{label}</strong>
        <small id={descriptionId}>{description}</small>
      </span>
      <span className="squish-switch-card__control">
        <input
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={disabled}
          aria-label={label}
          aria-describedby={descriptionId}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="squish-switch-card__track" aria-hidden="true"><span /></span>
        <span className="squish-switch-card__state" aria-hidden="true">{checked ? 'ACTIVÉ' : 'DÉSACTIVÉ'}</span>
      </span>
    </label>
  );
}
