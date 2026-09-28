import Runtime from './GlideSelectRuntime.jsx';

export interface GlideSelectOption {
  value: string;
  label: string;
  tag?: string;
}

interface GlideSelectProps {
  options: readonly GlideSelectOption[];
  value: string;
  onChange: (value: string) => void;
  labelledBy: string;
  describedBy?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  invalid?: boolean;
  ariaLabel?: string;
  showTags?: boolean;
}

/** Nebula-styled adapter around Noto's animated, keyboard-operable select. */
export function GlideSelect({
  options,
  value,
  onChange,
  labelledBy,
  describedBy,
  placeholder = 'Choisir une option…',
  disabled = false,
  required = false,
  invalid,
  ariaLabel = 'Sélectionner une option',
  showTags = true,
}: GlideSelectProps) {
  return (
    <Runtime
      options={options}
      value={value}
      onChange={(nextValue) => onChange(nextValue)}
      labelledBy={labelledBy}
      describedBy={describedBy}
      placeholder={placeholder}
      disabled={disabled}
      required={required}
      invalid={invalid}
      ariaLabel={ariaLabel}
      showTags={showTags}
      accentColor="var(--nether-magma, #ffb875)"
      surfaceColor="rgba(20, 16, 23, 0.98)"
      highlightColor="rgba(255, 184, 117, 0.18)"
      textColor="var(--nether-text, #fff7f0)"
      size="lg"
      radius={12}
      menuWidth={320}
      className="ncraft-glide-select"
    />
  );
}
