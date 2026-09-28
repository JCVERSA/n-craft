import Runtime from './RubberSegmentRuntime.jsx';

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
  ariaLabel?: string;
}

/** Nebula-styled adapter preserving Noto's elastic thumb and pointer physics. */
export function RubberSegment<T extends string>({
  options,
  value,
  onChange,
  labelledBy,
  disabled = false,
  ariaLabel,
}: RubberSegmentProps<T>) {
  return (
    <Runtime
      items={options}
      value={value}
      onChange={(nextValue) => onChange(nextValue as T)}
      labelledBy={labelledBy}
      ariaLabel={ariaLabel}
      trackColor="rgba(19, 15, 22, 0.96)"
      thumbColor="rgba(255, 184, 117, 0.96)"
      textColor="var(--nether-muted, #cabdca)"
      activeTextColor="#21160f"
      size="lg"
      radius={10}
      inset={3}
      equalSlots
      stretch={100}
      squash={3}
      disabled={disabled}
      className="ncraft-rubber-segment"
    />
  );
}
