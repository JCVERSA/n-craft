import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BEDROCK_METRICS_MAX_SAMPLES,
  BEDROCK_METRICS_STORAGE_KEY,
  BEDROCK_METRICS_WINDOW_MS,
  appendMetricSample,
  loadMetricHistory,
  normalizeMetricHistory,
  saveMetricHistory,
  type MetricStorage,
} from '../src/utils/metricHistory.ts';

const now = 1_800_000_000_000;

function memoryStorage(initial: Record<string, string> = {}): MetricStorage & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
  };
}

test('keeps only valid samples in the rolling five-minute window', () => {
  const result = normalizeMetricHistory([
    { timestamp: now - BEDROCK_METRICS_WINDOW_MS - 1, cpuPercent: 5, memoryBytes: 50 },
    { timestamp: now - 10_000, cpuPercent: 42.5, memoryBytes: 1_024 },
    { timestamp: now, cpuPercent: 101, memoryBytes: -1 },
    { timestamp: now + 60_000, cpuPercent: 30, memoryBytes: 200 },
    { timestamp: now - 5_000, cpuPercent: null, memoryBytes: 4_096 },
    null,
  ], now);

  assert.deepEqual(result, [
    { timestamp: now - 10_000, cpuPercent: 42.5, memoryBytes: 1_024 },
    { timestamp: now - 5_000, cpuPercent: null, memoryBytes: 4_096 },
  ]);
});

test('deduplicates samples by backend measurement time and caps the chart history', () => {
  let history = normalizeMetricHistory(Array.from({ length: BEDROCK_METRICS_MAX_SAMPLES }, (_, index) => ({
    timestamp: now - (BEDROCK_METRICS_MAX_SAMPLES - index) * 10_000,
    cpuPercent: index,
    memoryBytes: index * 1_024,
  })), now);
  history = appendMetricSample(history, { timestamp: now, cpuPercent: 50, memoryBytes: 2_048 }, now);
  history = appendMetricSample(history, { timestamp: now, cpuPercent: 51, memoryBytes: 3_072 }, now);

  assert.equal(history.length, BEDROCK_METRICS_MAX_SAMPLES);
  assert.equal(history.at(-1)?.cpuPercent, 51);
  assert.equal(new Set(history.map((sample) => sample.timestamp)).size, history.length);
});

test('persists only resource samples in browser storage and tolerates storage failures', () => {
  const storage = memoryStorage();
  const history = [{ timestamp: now, cpuPercent: 12.5, memoryBytes: 65_536 }];
  saveMetricHistory(history, storage, now);

  assert.deepEqual(loadMetricHistory(storage, now), history);
  assert.equal([...storage.values.keys()][0], BEDROCK_METRICS_STORAGE_KEY);
  assert.deepEqual(loadMetricHistory(null, now), []);
  assert.doesNotThrow(() => saveMetricHistory(history, {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('full'); },
  }, now));
});
