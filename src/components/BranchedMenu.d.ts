import type { JSX, ReactNode } from 'react';

export interface BranchedMenuChild {
  value: string;
  label: string;
  icon?: ReactNode;
}

export interface BranchedMenuItem {
  value?: string;
  label: string;
  icon?: ReactNode;
  children?: readonly BranchedMenuChild[];
}

export interface BranchedMenuProps {
  items?: readonly BranchedMenuItem[];
  defaultOpen?: number | readonly number[];
  defaultActive?: string;
  active?: string;
  ariaLabel?: string;
  onSelect?: (value: string, item: BranchedMenuChild | BranchedMenuItem) => void;
  onToggle?: (index: number, open: boolean) => void;
  color?: string;
  accentColor?: string;
  lineColor?: string;
  width?: number;
  rowHeight?: number;
  indent?: number;
  trunk?: number;
  radius?: number;
  lineWidth?: number;
  fontSize?: number;
  drawDuration?: number;
  foldDuration?: number;
  className?: string;
}

declare function BranchedMenu(props: BranchedMenuProps): JSX.Element;
export default BranchedMenu;
