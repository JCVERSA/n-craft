export const BEDROCK_METRICS_STORAGE_KEY = 'ncraft.bedrock-metrics.v1';
export const BEDROCK_METRICS_WINDOW_MS = 5 * 60 * 1_000;
export const BEDROCK_METRICS_MAX_SAMPLES = 31;

export interface BedrockMetricSample {
  timestamp: number;
  cpuPercent: number | null;
  memoryBytes: number | null;
}

export interface MetricStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSample(value: unknown): BedrockMetricSample | null {
  if (!isRecord(value)) return null;
  const timestamp = value.timestamp;
  const cpuPercent = value.cpuPercent;
  const memoryBytes = value.memoryBytes;
  if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp <= 0) return null;
  const cpu = typeof cpuPercent === 'number' && Number.isFinite(cpuPercent) && cpuPercent >= 0 && cpuPercent <= 100
    ? cpuPercent
    : null;
  const memory = typeof memoryBytes === 'number' && Number.isSafeInteger(memoryBytes) && memoryBytes >= 0
    ? memoryBytes
    : null;
  if (cpu === null && memory === null) return null;
  return { timestamp, cpuPercent: cpu, memoryBytes: memory };
}

export function normalizeMetricHistory(value: unknown, now = Date.now()): BedrockMetricSample[] {
  if (!Array.isArray(value)) return [];
  const earliest = now - BEDROCK_METRICS_WINDOW_MS;
  const latestAllowed = now + 30_000;
  const samples = new Map<number, BedrockMetricSample>();
  for (const item of value) {
    const sample = parseSample(item);
    if (!sample || sample.timestamp < earliest || sample.timestamp > latestAllowed) continue;
    samples.set(sample.timestamp, sample);
  }
  return [...samples.values()]
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(-BEDROCK_METRICS_MAX_SAMPLES);
}

export function appendMetricSample(
  history: BedrockMetricSample[],
  sample: BedrockMetricSample,
  now = Date.now(),
): BedrockMetricSample[] {
  return normalizeMetricHistory([...history, sample], now);
}

export function loadMetricHistory(storage: MetricStorage | null, now = Date.now()): BedrockMetricSample[] {
  if (!storage) return [];
  try {
    const serialized = storage.getItem(BEDROCK_METRICS_STORAGE_KEY);
    return serialized ? normalizeMetricHistory(JSON.parse(serialized) as unknown, now) : [];
  } catch {
    return [];
  }
}

export function saveMetricHistory(history: BedrockMetricSample[], storage: MetricStorage | null, now = Date.now()): void {
  if (!storage) return;
  try {
    storage.setItem(BEDROCK_METRICS_STORAGE_KEY, JSON.stringify(normalizeMetricHistory(history, now)));
  } catch {
    // Browser storage can be unavailable or full; the live graph still works in memory.
  }
}
