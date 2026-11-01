import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Clock3, Loader2, type LucideIcon } from 'lucide-react';
import { formatDuration, statusLabel } from './panelHelpers.ts';

export function PanelHeading({
  eyebrow,
  title,
  description,
  variant,
}: {
  eyebrow: string;
  title: string;
  description: string;
  variant?: 'deployment' | 'worlds' | 'diagnostics' | 'console';
}) {
  const variantClassName = variant ? ` ncraft-tab-heading--${variant}` : '';
  return (
    <header className={`ncraft-tab-heading${variantClassName}`}>
      <div className="ncraft-tab-heading__copy">
        <p className="nether-eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <span className="ncraft-tab-heading__ornament" aria-hidden="true"><span /><span /><span /></span>
    </header>
  );
}

export function StatusPill({ status, label }: { status: string; label?: string }) {
  const positive = ['running', 'configured', 'authenticated', 'success'].includes(status);
  const negative = ['failed', 'exited', 'tunnel_misconfigured'].includes(status);
  const tone = positive ? 'good' : negative ? 'bad' : ['stopped', 'idle'].includes(status) ? 'neutral' : 'warning';
  const text = label ?? statusLabel(status);
  return (
    <span className={`status-pill status-pill--${tone}`} aria-label={text} title={text}>
      <span className="status-pill__dot" aria-hidden="true" />
      {text}
    </span>
  );
}

export function LiveUptime({ startedAt }: { startedAt: string | null | undefined }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!startedAt || typeof document === 'undefined') return undefined;
    let timer: number | undefined;
    const stopClock = () => {
      if (timer === undefined) return;
      window.clearInterval(timer);
      timer = undefined;
    };
    const startClock = () => {
      if (document.visibilityState !== 'visible' || timer !== undefined) return;
      setNow(Date.now());
      timer = window.setInterval(() => setNow(Date.now()), 1000);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') startClock();
      else stopClock();
    };

    startClock();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      stopClock();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [startedAt]);

  const startedAtMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  const uptimeSeconds = startedAt && Number.isFinite(startedAtMs)
    ? Math.floor((now - startedAtMs) / 1000)
    : null;

  return <>{formatDuration(uptimeSeconds)}</>;
}

export function MetricTile({
  icon: Icon,
  label,
  value,
  detail,
  accent,
}: {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  detail: string;
  accent: 'portal' | 'soul' | 'magma' | 'moss';
}) {
  return (
    <div className={`metric-tile metric-tile--${accent}`}>
      <span className="metric-tile__icon"><Icon size={16} strokeWidth={1.9} /></span>
      <div className="metric-tile__copy">
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </div>
  );
}

export function WorldDetail({ label, value }: { label: string; value: string }) {
  return (
    <div className="world-detail-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function CheckRow({ label, ok, detail }: { label: string; ok: boolean | null; detail?: string }) {
  return (
    <div className={`system-check-row ${ok === null ? 'is-pending' : ok ? 'is-ok' : 'is-warning'}`}>
      <span className="system-check-row__icon" aria-hidden="true">
        {ok === null ? <Clock3 size={14} /> : ok ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
      </span>
      <div className="system-check-row__copy">
        <span>{label}</span>
        {detail && <small>{detail}</small>}
      </div>
    </div>
  );
}

export function PanelLoadingFallback({ label }: { label: string }) {
  return (
    <div className="pixel-studio-loading" role="status" aria-live="polite">
      <Loader2 className="spin-soft" size={20} /> {label}
    </div>
  );
}
