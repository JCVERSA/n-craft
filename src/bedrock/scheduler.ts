import type { BedrockConsole } from './console.ts';
import type { DeployPipeline } from './deployPipeline.ts';
import type { StateStore } from '../state.ts';
import type { ScheduledRestartPhase, ScheduledRestartSnapshot } from '../types/backend.ts';

export interface RestartScheduleOptions {
  enabled: boolean;
  time: string;
  timeZone: string;
  warningMinutes: number;
}

interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function parseTime(value: string): { hour: number; minute: number } | null {
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function getZonedDateTime(date: Date, timeZone: string): LocalDateTime {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const values = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function zonedDateTimeToUtc(local: LocalDateTime, timeZone: string): Date {
  const requestedLocalAsUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  let guess = requestedLocalAsUtc;
  // Correct the guess by the difference between the requested wall clock and
  // the wall clock represented by the guessed instant in the target timezone.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = getZonedDateTime(new Date(guess), timeZone);
    const actualLocalAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const difference = requestedLocalAsUtc - actualLocalAsUtc;
    if (difference === 0) break;
    guess += difference;
  }
  return new Date(guess);
}

/** Computes the next exact wall-clock occurrence in the requested timezone. */
export function computeNextScheduledRestart(now: Date, time: string, timeZone: string): Date {
  const targetTime = parseTime(time);
  if (!targetTime) throw new Error(`Heure de redémarrage invalide : ${time}`);
  // Validate the IANA timezone before doing calendar arithmetic.
  new Intl.DateTimeFormat('en-US', { timeZone }).format(now);

  const currentLocal = getZonedDateTime(now, timeZone);
  const todayTarget = zonedDateTimeToUtc({
    ...currentLocal,
    ...targetTime,
    second: 0,
  }, timeZone);
  if (todayTarget.getTime() > now.getTime()) return todayTarget;

  const tomorrow = new Date(Date.UTC(currentLocal.year, currentLocal.month - 1, currentLocal.day + 1));
  return zonedDateTimeToUtc({
    year: tomorrow.getUTCFullYear(),
    month: tomorrow.getUTCMonth() + 1,
    day: tomorrow.getUTCDate(),
    ...targetTime,
    second: 0,
  }, timeZone);
}

function readOptions(environment: NodeJS.ProcessEnv): RestartScheduleOptions {
  const enabledValue = environment.BDS_RESTART_ENABLED?.trim().toLowerCase();
  const enabled = enabledValue === undefined
    ? true
    : !['0', 'false', 'no', 'off'].includes(enabledValue);
  const time = environment.BDS_RESTART_TIME?.trim() || '04:00';
  const timeZone = environment.BDS_RESTART_TIMEZONE?.trim() || 'Africa/Douala';
  const rawMinutes = Number(environment.BDS_RESTART_WARNING_MINUTES ?? 5);
  const warningMinutes = Number.isSafeInteger(rawMinutes) && rawMinutes >= 1 && rawMinutes <= 30
    ? rawMinutes
    : 5;
  return { enabled, time, timeZone, warningMinutes };
}

export class BedrockRestartScheduler {
  private readonly options: RestartScheduleOptions;
  private timer: NodeJS.Timeout | null = null;
  private countdownTimer: NodeJS.Timeout | null = null;
  private countdownResolve: ((completed: boolean) => void) | null = null;
  private nextRestartAt: Date | null = null;
  private lastScheduledAt: Date | null = null;
  private countdownEndsAt: number | null = null;
  private phase: ScheduledRestartPhase = 'idle';
  private error: string | null = null;
  private started = false;
  private shuttingDown = false;
  private activeOperation: Promise<void> | null = null;

  constructor(
    private readonly state: StateStore,
    private readonly bedrockConsole: BedrockConsole,
    private readonly pipeline: DeployPipeline,
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    this.options = readOptions(environment);
    if (this.options.enabled) {
      try {
        if (!parseTime(this.options.time)) throw new Error(`Heure invalide « ${this.options.time} ».`);
        new Intl.DateTimeFormat('en-US', { timeZone: this.options.timeZone });
      } catch (error) {
        this.options.enabled = false;
        this.error = `Planification désactivée : ${(error as Error).message}`;
        this.phase = 'failed';
      }
    }
  }

  start(): void {
    if (this.started || this.shuttingDown) return;
    this.started = true;
    if (!this.options.enabled) {
      if (this.error) console.warn(`[scheduler] ${this.error}`);
      else console.info('[scheduler] Redémarrage quotidien désactivé par BDS_RESTART_ENABLED.');
      return;
    }
    console.info(`[scheduler] Redémarrage Bedrock quotidien à ${this.options.time} (${this.options.timeZone}).`);
    this.scheduleNext();
  }

  getSnapshot(): ScheduledRestartSnapshot {
    return {
      enabled: this.options.enabled,
      time: this.options.time,
      timeZone: this.options.timeZone,
      warningMinutes: this.options.warningMinutes,
      nextRestartAt: this.nextRestartAt?.toISOString() ?? null,
      phase: this.phase,
      countdownSeconds: this.countdownEndsAt === null
        ? null
        : Math.max(0, Math.ceil((this.countdownEndsAt - Date.now()) / 1000)),
      error: this.error,
    };
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.cancelCountdownDelay();
    await this.activeOperation?.catch(() => undefined);
  }

  private scheduleNext(): void {
    if (this.shuttingDown || !this.options.enabled) return;
    if (this.timer) clearTimeout(this.timer);

    const now = new Date();
    const reference = this.lastScheduledAt && this.lastScheduledAt.getTime() > now.getTime()
      ? this.lastScheduledAt
      : now;
    const next = computeNextScheduledRestart(reference, this.options.time, this.options.timeZone);
    this.nextRestartAt = next;
    // The configured time is the actual restart time, so begin the in-game
    // warning window five minutes earlier (or as configured).
    const warningStartAt = next.getTime() - this.options.warningMinutes * 60_000;
    const delay = Math.max(0, warningStartAt - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.lastScheduledAt = next;
      const operation = this.runScheduledRestart(next);
      this.activeOperation = operation;
      void operation.catch((error) => {
        this.phase = 'failed';
        this.error = (error as Error).message || 'Échec inattendu du redémarrage planifié.';
        console.error(`[scheduler] ${this.error}`);
      }).finally(() => {
        if (this.activeOperation === operation) this.activeOperation = null;
        if (!this.shuttingDown) this.scheduleNext();
      });
    }, delay);
    this.timer.unref?.();
  }

  private async runScheduledRestart(scheduledRestartAt: Date): Promise<void> {
    this.nextRestartAt = scheduledRestartAt;
    this.error = null;
    if (!this.shouldRestart()) {
      this.phase = 'idle';
      console.info('[scheduler] Redémarrage planifié ignoré : le serveur Bedrock est arrêté ou occupé.');
      return;
    }

    this.phase = 'countdown';
    this.countdownEndsAt = scheduledRestartAt.getTime();
    let lastAnnouncedMinutes = -1;
    while (Date.now() < scheduledRestartAt.getTime()) {
      if (!this.shouldRestart()) {
        this.cancelCountdown();
        return;
      }

      const remainingMs = scheduledRestartAt.getTime() - Date.now();
      const remainingMinutes = Math.ceil(remainingMs / 60_000);
      if (remainingMinutes !== lastAnnouncedMinutes) {
        const timeLabel = remainingMs < 60_000
          ? `${Math.max(1, Math.ceil(remainingMs / 1000))} secondes`
          : remainingMinutes === 1 ? '1 minute' : `${remainingMinutes} minutes`;
        const sent = this.bedrockConsole.sendCommand(
          `say [Nebula Craft] Redémarrage quotidien dans ${timeLabel}. Le serveur va s’arrêter puis redémarrer automatiquement.`,
        );
        if (!sent) {
          this.cancelCountdown();
          return;
        }
        lastAnnouncedMinutes = remainingMinutes;
      }

      const nextAnnouncementAt = scheduledRestartAt.getTime() - Math.max(0, remainingMinutes - 1) * 60_000;
      const waitMs = Math.min(remainingMs, Math.max(1, nextAnnouncementAt - Date.now()));
      const completed = await this.wait(waitMs);
      if (!completed) return;
    }

    if (this.shuttingDown || !this.shouldRestart()) {
      this.cancelCountdown();
      return;
    }

    this.countdownEndsAt = null;
    this.phase = 'restarting';
    try {
      await this.pipeline.restartExisting();
      const server = this.state.getSnapshot().server;
      if (server.status !== 'running') {
        throw new Error(server.error || 'Bedrock ne s’est pas remis en ligne après le redémarrage.');
      }
      this.phase = 'idle';
      console.info('[scheduler] Redémarrage quotidien terminé ; Bedrock est en ligne.');
    } catch (error) {
      this.phase = 'failed';
      this.error = (error as Error).message || 'Échec du redémarrage quotidien.';
      console.error(`[scheduler] ${this.error}`);
    }
  }

  private shouldRestart(): boolean {
    return !this.shuttingDown &&
      !this.pipeline.isRunning &&
      this.bedrockConsole.isReady &&
      this.state.getSnapshot().server.status === 'running';
  }

  private wait(milliseconds: number): Promise<boolean> {
    if (this.shuttingDown) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      this.countdownTimer = setTimeout(() => {
        this.countdownTimer = null;
        this.countdownResolve = null;
        resolve(true);
      }, milliseconds);
      this.countdownResolve = resolve;
    });
  }

  private cancelCountdownDelay(): void {
    if (this.countdownTimer) clearTimeout(this.countdownTimer);
    this.countdownTimer = null;
    const resolve = this.countdownResolve;
    this.countdownResolve = null;
    resolve?.(false);
  }

  private cancelCountdown(): void {
    this.cancelCountdownDelay();
    this.countdownEndsAt = null;
    this.phase = 'idle';
  }
}
