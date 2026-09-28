import { useEffect, useState } from 'react';
import { Activity, Cpu, MemoryStick } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import type { ServerLifecycle } from '../types/backend.ts';
import { BEDROCK_METRICS_WINDOW_MS, type BedrockMetricSample } from '../utils/metricHistory.ts';

interface BedrockMetricsChartProps {
  samples: BedrockMetricSample[];
  serverStatus: ServerLifecycle | undefined;
}

const WIDTH = 720;
const HEIGHT = 286;
const LEFT = 62;
const RIGHT = 650;
const TOP = 22;
const BOTTOM = 222;
const PLOT_WIDTH = RIGHT - LEFT;
const PLOT_HEIGHT = BOTTOM - TOP;
const GIB = 1024 ** 3;

function toPlotX(timestamp: number, now: number): number {
  const start = now - BEDROCK_METRICS_WINDOW_MS;
  const progress = Math.max(0, Math.min(1, (timestamp - start) / BEDROCK_METRICS_WINDOW_MS));
  return LEFT + progress * PLOT_WIDTH;
}

function toPlotY(value: number, max: number): number {
  const progress = Math.max(0, Math.min(1, value / max));
  return BOTTOM - progress * PLOT_HEIGHT;
}

function makePath(
  samples: BedrockMetricSample[],
  now: number,
  selectValue: (sample: BedrockMetricSample) => number | null,
  maxValue: number,
): string {
  const points = samples.flatMap((sample) => {
    const value = selectValue(sample);
    return value === null ? [] : [[toPlotX(sample.timestamp, now), toPlotY(value, maxValue)] as const];
  });
  return points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
}

function formatGigabytes(bytes: number | null): string {
  return bytes === null ? '—' : `${(bytes / GIB).toFixed(2)} Go`;
}

function formatAge(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 5) return 'à l’instant';
  if (seconds < 60) return `il y a ${seconds} s`;
  return `il y a ${Math.floor(seconds / 60)} min`;
}

function timeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function sampleTimeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function BedrockMetricsChart({ samples, serverStatus }: BedrockMetricsChartProps) {
  const reduceMotion = useReducedMotion();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let timer: number | undefined;
    const stopClock = () => {
      if (timer === undefined) return;
      window.clearInterval(timer);
      timer = undefined;
    };
    const startClock = () => {
      if (document.visibilityState !== 'visible' || timer !== undefined) return;
      setNow(Date.now());
      timer = window.setInterval(() => setNow(Date.now()), 10_000);
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
  }, []);

  const visibleSamples = samples.filter((sample) => sample.timestamp >= now - BEDROCK_METRICS_WINDOW_MS && sample.timestamp <= now + 30_000);
  const latest = visibleSamples.at(-1);
  const memoryValues = visibleSamples.flatMap((sample) => sample.memoryBytes === null ? [] : [sample.memoryBytes]);
  const largestMemory = Math.max(0, ...memoryValues);
  const memoryScaleGiB = Math.max(0.5, Math.ceil((largestMemory / GIB) * 2) / 2);
  const memoryScaleBytes = memoryScaleGiB * GIB;
  const cpuPath = makePath(visibleSamples, now, (sample) => sample.cpuPercent, 100);
  const memoryPath = makePath(visibleSamples, now, (sample) => sample.memoryBytes, memoryScaleBytes);
  const measurementIsFresh = Boolean(latest && now - latest.timestamp <= 25_000 && serverStatus === 'running');
  const helperText = !latest
    ? serverStatus === 'running' ? 'En attente de la première mesure Bedrock…' : 'Les mesures apparaîtront au prochain démarrage de Bedrock.'
    : serverStatus === 'running'
      ? `Processus Bedrock · mesure ${formatAge(latest.timestamp, now)} · échantillonnage toutes les 10 s`
      : `Bedrock ${serverStatus === 'stopped' ? 'est arrêté' : 'n’est pas en ligne'} · dernière mesure ${formatAge(latest.timestamp, now)}`;
  const xLabels = [now - BEDROCK_METRICS_WINDOW_MS, now - BEDROCK_METRICS_WINDOW_MS / 2, now];
  const memoryTicks = [memoryScaleGiB, memoryScaleGiB / 2, 0];

  return (
    <motion.section
      className="nether-card nether-card--portal resource-chart-card"
      initial={reduceMotion ? false : { opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, delay: reduceMotion ? 0 : 0.12, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="nether-card__header">
        <div className="nether-card__identity">
          <span className="nether-card__icon nether-card__icon--portal" aria-hidden="true"><Activity size={18} /></span>
          <div className="min-w-0">
            <p className="nether-eyebrow">TÉLÉMÉTRIE EN DIRECT</p>
            <h2 className="nether-card__title">Charge Bedrock</h2>
            <p className="nether-card__description">Historique glissant des cinq dernières minutes</p>
          </div>
        </div>
        <span className={`nether-live-indicator ${measurementIsFresh ? 'is-live' : ''}`}>
          <span className="nether-live-indicator__dot" />
          {measurementIsFresh ? 'EN DIRECT' : 'HISTORIQUE'}
        </span>
      </div>

      <div className="nether-card__body resource-chart-body">
        <div className="resource-chart-readouts">
          <div className="resource-readout resource-readout--cpu">
            <span className="resource-readout__icon"><Cpu size={16} /></span>
            <div>
              <p>{measurementIsFresh ? 'CPU · EN DIRECT' : 'CPU · DERNIER RELEVÉ'}</p>
              <strong>{latest?.cpuPercent === null || latest?.cpuPercent === undefined ? '—' : `${latest.cpuPercent.toFixed(1)} %`}</strong>
            </div>
          </div>
          <div className="resource-readout resource-readout--memory">
            <span className="resource-readout__icon"><MemoryStick size={16} /></span>
            <div>
              <p>{measurementIsFresh ? 'RAM · EN DIRECT' : 'RAM · DERNIER RELEVÉ'}</p>
              <strong>{formatGigabytes(latest?.memoryBytes ?? null)}</strong>
            </div>
          </div>
        </div>

        <div className="resource-chart-legend" role="list" aria-label="Légende du graphique">
          <span role="listitem"><i className="legend-line legend-line--cpu" aria-hidden="true" />CPU (%) · ligne pleine</span>
          <span role="listitem"><i className="legend-line legend-line--memory" aria-hidden="true" />RAM (Go) · ligne tiretée</span>
          <span className="resource-chart-legend__note" role="listitem">Mesures du processus Bedrock uniquement</span>
        </div>

        <div className="resource-chart-plot" role="img" aria-label="Graphique sur cinq minutes de l’utilisation CPU et mémoire du processus Bedrock" aria-describedby="resource-chart-summary">
          {visibleSamples.length === 0 ? (
            <div className="resource-chart-empty">
              <Activity size={25} strokeWidth={1.5} />
              <span>Aucun historique pour le moment</span>
              <small>{helperText}</small>
            </div>
          ) : (
            <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" className="resource-chart-svg" aria-hidden="true">
              <defs>
                <linearGradient id="resourceCpuFill" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="#ffad66" stopOpacity="0.22" />
                  <stop offset="100%" stopColor="#ffad66" stopOpacity="0" />
                </linearGradient>
                <linearGradient id="resourceMemoryFill" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="#b996ff" stopOpacity="0.2" />
                  <stop offset="100%" stopColor="#b996ff" stopOpacity="0" />
                </linearGradient>
                <clipPath id="resourceChartClip">
                  <rect x={LEFT} y={TOP} width={PLOT_WIDTH} height={PLOT_HEIGHT} />
                </clipPath>
              </defs>

              {[0, 25, 50, 75, 100].map((tick) => {
                const y = toPlotY(tick, 100);
                return (
                  <g key={tick}>
                    <line x1={LEFT} x2={RIGHT} y1={y} y2={y} className="resource-chart-gridline" />
                    <text x={LEFT - 12} y={y + 4} textAnchor="end" className="resource-chart-axis-label">{tick}%</text>
                  </g>
                );
              })}

              {memoryTicks.map((tick, index) => {
                const y = toPlotY(tick * GIB, memoryScaleBytes);
                return <text key={index} x={RIGHT + 12} y={y + 4} textAnchor="start" className="resource-chart-axis-label">{tick.toFixed(tick % 1 === 0 ? 0 : 1)}</text>;
              })}

              {xLabels.map((timestamp, index) => {
                const x = toPlotX(timestamp, now);
                return (
                  <g key={index}>
                    <line x1={x} x2={x} y1={TOP} y2={BOTTOM} className="resource-chart-gridline resource-chart-gridline--vertical" />
                    <text x={x} y={BOTTOM + 24} textAnchor={index === 0 ? 'start' : index === xLabels.length - 1 ? 'end' : 'middle'} className="resource-chart-axis-label">{index === xLabels.length - 1 ? 'maintenant' : timeLabel(timestamp)}</text>
                  </g>
                );
              })}

              <text x={RIGHT + 12} y={TOP - 8} textAnchor="start" className="resource-chart-axis-caption">Go</text>
              <g clipPath="url(#resourceChartClip)">
                {memoryPath && <path d={`${memoryPath} L ${toPlotX(visibleSamples.at(-1)?.timestamp ?? now, now)} ${BOTTOM} L ${toPlotX(visibleSamples[0]?.timestamp ?? now, now)} ${BOTTOM} Z`} fill="url(#resourceMemoryFill)" />}
                {cpuPath && <path d={`${cpuPath} L ${toPlotX(visibleSamples.at(-1)?.timestamp ?? now, now)} ${BOTTOM} L ${toPlotX(visibleSamples[0]?.timestamp ?? now, now)} ${BOTTOM} Z`} fill="url(#resourceCpuFill)" />}
                {memoryPath && <path d={memoryPath} className="resource-chart-line resource-chart-line--memory" />}
                {cpuPath && <path d={cpuPath} className="resource-chart-line resource-chart-line--cpu" />}
              </g>
              {latest?.cpuPercent !== null && latest?.cpuPercent !== undefined && (
                <circle cx={toPlotX(latest.timestamp, now)} cy={toPlotY(latest.cpuPercent, 100)} r="4" className="resource-chart-point resource-chart-point--cpu"><title>CPU {latest.cpuPercent.toFixed(1)} % · {timeLabel(latest.timestamp)}</title></circle>
              )}
              {latest?.memoryBytes !== null && latest?.memoryBytes !== undefined && (
                <rect
                  x={toPlotX(latest.timestamp, now) - 3.5}
                  y={toPlotY(latest.memoryBytes, memoryScaleBytes) - 3.5}
                  width="7"
                  height="7"
                  transform={`rotate(45 ${toPlotX(latest.timestamp, now)} ${toPlotY(latest.memoryBytes, memoryScaleBytes)})`}
                  className="resource-chart-point resource-chart-point--memory"
                >
                  <title>RAM {formatGigabytes(latest.memoryBytes)} · {timeLabel(latest.timestamp)}</title>
                </rect>
              )}
            </svg>
          )}
        </div>
        {visibleSamples.length > 0 && (
          <details className="resource-chart-details">
            <summary>
              <span>Afficher le tableau des relevés</span>
              <span>{visibleSamples.length} échantillons</span>
            </summary>
            <div className="resource-chart-table-scroll" role="region" aria-label="Relevés CPU et RAM de Bedrock" tabIndex={0}>
              <table className="resource-chart-table">
                <caption>Mesures reçues du processus Bedrock pendant les cinq dernières minutes</caption>
                <thead>
                  <tr><th scope="col">Heure</th><th scope="col">CPU</th><th scope="col">RAM</th></tr>
                </thead>
                <tbody>
                  {visibleSamples.map((sample) => (
                    <tr key={sample.timestamp}>
                      <th scope="row"><time dateTime={new Date(sample.timestamp).toISOString()}>{sampleTimeLabel(sample.timestamp)}</time></th>
                      <td>{sample.cpuPercent === null ? '—' : `${sample.cpuPercent.toFixed(1)} %`}</td>
                      <td>{formatGigabytes(sample.memoryBytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
        <p id="resource-chart-summary" className="resource-chart-footnote">{helperText}. Historique local à ce navigateur; ces mesures ne garantissent pas la joignabilité du port UDP.</p>
      </div>
    </motion.section>
  );
}
