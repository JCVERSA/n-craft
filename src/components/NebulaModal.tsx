import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion, useReducedMotion } from 'motion/react';
import { Info, X, type LucideIcon } from 'lucide-react';

export type NebulaModalTone = 'neutral' | 'magma' | 'warning' | 'danger';
export type NebulaModalFocus = 'close' | 'primary' | 'cancel' | 'input';

interface NebulaModalProps {
  title: string;
  eyebrow?: string;
  icon?: LucideIcon;
  tone?: NebulaModalTone;
  size?: 'compact' | 'regular' | 'wide';
  role?: 'dialog' | 'alertdialog';
  describedById?: string;
  initialFocus?: NebulaModalFocus;
  closeLabel?: string;
  onClose: () => void;
  children: ReactNode;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(
    'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
  )).filter((element) => !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true');
}

export function NebulaModal({
  title,
  eyebrow = 'NEBULA CRAFT · CONTROL DECK',
  icon: Icon = Info,
  tone = 'neutral',
  size = 'regular',
  role = 'dialog',
  describedById,
  initialFocus = 'close',
  closeLabel = 'Fermer la fenêtre',
  onClose,
  children,
}: NebulaModalProps) {
  const generatedId = useId().replace(/:/g, '');
  const titleId = `ncraft-modal-title-${generatedId}`;
  const panelRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const reduceMotion = useReducedMotion();
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const appRoot = document.getElementById('root');
    const hadInert = appRoot?.hasAttribute('inert') ?? false;
    const previousBodyOverflow = document.body.style.overflow;
    appRoot?.setAttribute('inert', '');
    document.body.style.overflow = 'hidden';

    const panel = panelRef.current;
    const focusInitialControl = () => {
      if (!panel) return;
      const selector = initialFocus === 'input'
        ? 'input:not(:disabled)'
        : initialFocus === 'cancel'
          ? '[data-modal-cancel="true"]'
          : initialFocus === 'primary'
            ? '[data-modal-primary="true"]'
            : '[data-modal-close="true"]';
      const target = panel.querySelector<HTMLElement>(selector) ?? panel;
      target.focus({ preventScroll: true });
    };
    const animationFrame = window.requestAnimationFrame(focusInitialControl);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;
      const items = focusableElements(panel);
      if (items.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      document.removeEventListener('keydown', handleKeyDown, true);
      if (!hadInert) appRoot?.removeAttribute('inert');
      document.body.style.overflow = previousBodyOverflow;
      if (previousFocus?.isConnected) {
        window.requestAnimationFrame(() => {
          if (!document.querySelector('[aria-modal="true"]')) previousFocus.focus({ preventScroll: true });
        });
      }
    };
  }, [initialFocus]);

  return createPortal(
    <motion.div
      className="ncraft-modal-backdrop"
      role="presentation"
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, transition: { duration: 0.14 } }}
      transition={{ duration: reduceMotion ? 0 : 0.18 }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <motion.section
        ref={panelRef}
        tabIndex={-1}
        className={`ncraft-modal ncraft-modal--${size} ncraft-modal--${tone}`}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedById}
        initial={reduceMotion ? false : { opacity: 0, y: 12, scale: 0.975 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.985 }}
        transition={{ type: 'spring', stiffness: 360, damping: 30, mass: 0.8 }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="ncraft-modal__orbit ncraft-modal__orbit--outer" aria-hidden="true" />
        <span className="ncraft-modal__orbit ncraft-modal__orbit--inner" aria-hidden="true" />
        <header className="ncraft-modal__header">
          <span className={`ncraft-modal__icon ncraft-modal__icon--${tone}`} aria-hidden="true">
            <Icon size={20} strokeWidth={1.9} />
          </span>
          <div className="ncraft-modal__heading">
            <span className="ncraft-modal__eyebrow">{eyebrow}</span>
            <h2 id={titleId}>{title}</h2>
          </div>
          <button
            type="button"
            className="ncraft-modal__close"
            data-modal-close="true"
            aria-label={closeLabel}
            title={closeLabel}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className="ncraft-modal__body">{children}</div>
      </motion.section>
    </motion.div>,
    document.body,
  );
}
