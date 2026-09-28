import type { JSX, ReactNode } from 'react';

export interface RubberSegmentRuntimeItem<T extends string = string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

export interface RubberSegmentRuntimeProps<T extends string = string> {
  items: readonly (string | RubberSegmentRuntimeItem<T>)[];
  value?: T;
  defaultValue?: T;
  onChange?: (value: T, index: number) => void;
  trackColor?: string;
  thumbColor?: string;
  textColor?: string;
  activeTextColor?: string;
  size?: 'sm' | 'md' | 'lg';
  radius?: number;
  inset?: number;
  equalSlots?: boolean;
  stretch?: number;
  squash?: number;
  speed?: number;
  glide?: number;
  draggable?: boolean;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
  ariaLabel?: string;
  labelledBy?: string;
}

declare function RubberSegmentRuntime<T extends string = string>(props: RubberSegmentRuntimeProps<T>): JSX.Element;
export default RubberSegmentRuntime;
