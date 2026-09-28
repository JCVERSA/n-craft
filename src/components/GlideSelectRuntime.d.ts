import type { ComponentType } from 'react';

export interface GlideSelectRuntimeOption {
  value: string;
  label: string;
  tag?: string;
}

export interface GlideSelectRuntimeProps {
  options?: readonly (string | GlideSelectRuntimeOption)[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string, option: GlideSelectRuntimeOption) => void;
  placeholder?: string;
  showTags?: boolean;
  accentColor?: string;
  surfaceColor?: string;
  highlightColor?: string;
  textColor?: string;
  size?: 'sm' | 'md' | 'lg';
  radius?: number;
  menuWidth?: number;
  placement?: 'top' | 'bottom';
  align?: 'left' | 'right';
  popDuration?: number;
  glideDuration?: number;
  rememberPosition?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  labelledBy?: string;
  describedBy?: string;
  required?: boolean;
  invalid?: boolean;
  className?: string;
}

declare const GlideSelectRuntime: ComponentType<GlideSelectRuntimeProps>;
export default GlideSelectRuntime;
