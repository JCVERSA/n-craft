import type { JSX, ReactNode } from 'react';

export type RefineFrameStatus = 'queued' | 'generating' | 'refining' | 'complete' | 'error';
export type RefineFrameLabels = Partial<Record<RefineFrameStatus, string>>;

export interface RefineFrameProps {
  status?: RefineFrameStatus;
  children: ReactNode;
  aspectRatio?: string;
  width?: number;
  radius?: number;
  background?: string;
  color?: string;
  stageDuration?: number;
  sweep?: boolean;
  showStatus?: boolean;
  hideAfter?: number;
  labels?: RefineFrameLabels;
  retryLabel?: string;
  onRetry?: () => void;
  className?: string;
}

declare function RefineFrame(props: RefineFrameProps): JSX.Element;
export default RefineFrame;
