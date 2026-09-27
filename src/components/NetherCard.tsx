import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';

type Accent = 'magma' | 'portal' | 'soul' | 'moss';

interface NetherCardProps {
  id?: string;
  title: string;
  eyebrow?: string;
  description?: string;
  icon: LucideIcon;
  accent?: Accent;
  className?: string;
  delay?: number;
  action?: ReactNode;
  children: ReactNode;
}

export function NetherCard({
  id,
  title,
  eyebrow,
  description,
  icon: Icon,
  accent = 'magma',
  className = '',
  delay = 0,
  action,
  children,
}: NetherCardProps) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.section
      id={id}
      className={`nether-card nether-card--${accent} ${className}`.trim()}
      initial={reduceMotion ? false : { opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.42, delay: reduceMotion ? 0 : delay, ease: [0.22, 1, 0.36, 1] }}
      whileHover={reduceMotion ? undefined : { y: -2 }}
    >
      <header className="nether-card__header">
        <div className="nether-card__identity">
          <span className="nether-card__icon" aria-hidden="true"><Icon size={18} strokeWidth={1.8} /></span>
          <div className="min-w-0">
            {eyebrow && <p className="nether-eyebrow">{eyebrow}</p>}
            <h2 className="nether-card__title">{title}</h2>
            {description && <p className="nether-card__description">{description}</p>}
          </div>
        </div>
        {action && <div className="nether-card__action">{action}</div>}
      </header>
      <div className="nether-card__body">{children}</div>
    </motion.section>
  );
}
