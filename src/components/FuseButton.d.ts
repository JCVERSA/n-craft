import type { JSX, ReactNode } from 'react';

export type FuseButtonPhase = 'idle' | 'armed' | 'settled';
export type FuseButtonCommitReason = 'press' | 'fuseEnd';

export interface FuseButtonProps {
  label?: string;
  undoLabel?: string;
  doneLabel?: string;
  icon?: ReactNode;
  color?: string;
  background?: string;
  fuseColor?: string;
  size?: 'sm' | 'md' | 'lg';
  radius?: number;
  undoWindow?: number;
  fuse?: 'outline' | 'line';
  fuseThickness?: number;
  crossfadeMs?: number;
  commitOn?: 'press' | 'fuseEnd';
  pauseOnHover?: boolean;
  settle?: 'reset' | 'stay';
  disabled?: boolean;
  onCommit?: (reason: FuseButtonCommitReason) => void;
  onUndo?: () => void;
  onFuseEnd?: () => void;
  onPhaseChange?: (phase: FuseButtonPhase) => void;
  className?: string;
  type?: 'button' | 'submit' | 'reset';
}

declare function FuseButton(props: FuseButtonProps): JSX.Element;
export default FuseButton;
