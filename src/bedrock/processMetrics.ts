import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import type { StateStore } from '../state.ts';

// Linux exposes process CPU counters in USER_HZ ticks; the Linux ABI uses 100.
const LINUX_USER_HZ = 100;
const SAMPLE_INTERVAL_MS = 10_000;

export interface CpuSample {
  pid: number;
  cpuTicks: number;
  sampledAtMs: number;
}

export interface ProcessMetrics {
  cpuPercent: number | null;
  memoryBytes: number | null;
  sample: CpuSample | null;
}

export function parseLinuxProcessCpuTicks(statContent: string): number | null {
  // The process name in /proc/PID/stat is parenthesized and may itself contain spaces
  // or parentheses, so start parsing after the last closing parenthesis.
  const commandEnd = statContent.lastIndexOf(')');
  if (commandEnd < 0) return null;
  const fields = statContent.slice(commandEnd + 1).trim().split(/\s+/);
  if (fields.length < 13) return null;
  const userTicks = Number(fields[11]);
  const systemTicks = Number(fields[12]);
  if (!Number.isFinite(userTicks) || !Number.isFinite(systemTicks)) return null;
  return userTicks + systemTicks;
}

export function parseLinuxResidentMemoryBytes(statusContent: string): number | null {
  const residentKb = statusContent.match(/^VmRSS:\s*(\d+)\s+kB\s*$/im)?.[1];
  if (!residentKb) return null;
  const bytes = Number(residentKb) * 1024;
  return Number.isSafeInteger(bytes) ? bytes : null;
}

export async function readBedrockProcessMetrics(pid: number, previous: CpuSample | null): Promise<ProcessMetrics> {
  const [statContent, statusContent] = await Promise.all([
    readFile(`/proc/${pid}/stat`, 'utf8'),
    readFile(`/proc/${pid}/status`, 'utf8'),
  ]);
  const cpuTicks = parseLinuxProcessCpuTicks(statContent);
  const sampledAtMs = performance.now();
  const sample = cpuTicks === null ? null : { pid, cpuTicks, sampledAtMs };
  let cpuPercent: number | null = null;

  if (sample && previous?.pid === pid) {
    const elapsedSeconds = (sampledAtMs - previous.sampledAtMs) / 1000;
    const elapsedTicks = sample.cpuTicks - previous.cpuTicks;
    if (elapsedSeconds > 0 && elapsedTicks >= 0) {
      const logicalCpus = Math.max(1, os.availableParallelism());
      cpuPercent = Math.max(0, Math.min(100,
        (elapsedTicks / LINUX_USER_HZ / elapsedSeconds / logicalCpus) * 100,
      ));
    }
  }

  return {
    cpuPercent,
    memoryBytes: parseLinuxResidentMemoryBytes(statusContent),
    sample,
  };
}

/** Samples only the Bedrock child process; it never reports the panel's own CPU as BDS usage. */
export class BedrockMetricsSampler {
  private timer: NodeJS.Timeout | null = null;
  private previousSample: CpuSample | null = null;
  private sampling: Promise<void> | null = null;

  constructor(private readonly state: StateStore, private readonly intervalMs = SAMPLE_INTERVAL_MS) {}

  start(): void {
    if (this.timer) return;
    void this.collect();
    this.timer = setInterval(() => { void this.collect(); }, this.intervalMs);
    this.timer.unref?.();
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.sampling;
  }

  private collect(): Promise<void> {
    if (this.sampling) return this.sampling;
    const collection = this.readAndStore().finally(() => {
      if (this.sampling === collection) this.sampling = null;
    });
    this.sampling = collection;
    return collection;
  }

  private async readAndStore(): Promise<void> {
    const before = this.state.getSnapshot().server;
    if (before.status !== 'running' || !before.pid) {
      this.previousSample = null;
      return;
    }

    try {
      const metrics = await readBedrockProcessMetrics(before.pid, this.previousSample);
      const after = this.state.getSnapshot().server;
      if (after.status !== 'running' || after.pid !== before.pid) {
        this.previousSample = null;
        return;
      }
      this.previousSample = metrics.sample;
      await this.state.updateServer({
        cpuPercent: metrics.cpuPercent,
        memoryBytes: metrics.memoryBytes,
        metricsUpdatedAt: new Date().toISOString(),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ESRCH') {
        console.warn(`[metrics] Could not read Bedrock process usage: ${(error as Error).message}`);
      }
      this.previousSample = null;
    }
  }
}
