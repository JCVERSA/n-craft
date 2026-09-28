import type { JSX, ReactNode } from 'react';

export type SwipeToastCloseReason = 'timeout' | 'programmatic' | 'escape' | 'action' | 'close' | 'swipe';

export interface SwipeToastProps {
  title?: string;
  description?: string;
  icon?: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  open?: boolean;
  onClose?: (reason: SwipeToastCloseReason) => void;
  background?: string;
  color?: string;
  fuseColor?: string;
  width?: number;
  radius?: number;
  slideMs?: number;
  settleBounce?: number;
  swipeDistance?: number;
  duration?: number;
  fuse?: 'top' | 'bottom' | 'none';
  pauseOnHover?: boolean;
  closeButton?: boolean;
  closeLabel?: string;
  inline?: boolean;
  dismissible?: boolean;
  className?: string;
}

declare function SwipeToast(props: SwipeToastProps): JSX.Element;
export default SwipeToast;
