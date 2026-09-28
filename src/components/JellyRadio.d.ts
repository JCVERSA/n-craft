import type { JSX, ReactNode } from 'react';

export interface JellyRadioOption<T extends string | number | boolean = string> {
  value: T;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
}

export type JellyRadioItem<T extends string | number | boolean = string> = string | JellyRadioOption<T>;

export interface JellyRadioProps<T extends string | number | boolean = string> {
  items?: readonly JellyRadioItem<T>[];
  value?: T;
  defaultValue?: T;
  onChange?: (value: T, index: number) => void;
  chipColor?: string;
  activeColor?: string;
  textColor?: string;
  activeTextColor?: string;
  size?: 'sm' | 'md' | 'lg';
  gap?: number;
  radius?: number;
  swell?: number;
  barge?: number;
  shrink?: number;
  jelly?: number;
  bounce?: number;
  stagger?: number;
  stiffness?: number;
  disabled?: boolean;
  ariaLabel?: string;
  labelledBy?: string;
  describedBy?: string;
  className?: string;
}

declare function JellyRadio<T extends string | number | boolean = string>(props: JellyRadioProps<T>): JSX.Element;
export default JellyRadio;
