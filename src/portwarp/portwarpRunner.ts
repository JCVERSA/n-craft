import { spawn, type ChildProcess } from 'node:child_process';
import { resolveExecutable } from '../preflight.ts';
import type { PortwarpLifecycle, PortwarpLoginSnapshot } from '../types/backend.ts';
import type { StateStore } from '../state.ts';
import { buildChildEnvironment } from '../childEnvironment.ts';

const DEVICE_URL = 'https://portwarp.com/device';
const MAX_OUTPUT_CHARS = 32_000;
const AUTH_ERROR = /(?:not\s+(?:signed|logged)\s+in|(?:signed|logged)\s+out|unauthenticated|not\s+authenticated|authentication\s+required|login\s+required|sign[ -]?in\s+required|run[^\n]{0,20}pwrp\s+login|please\s+(?:sign\s+in|login)|no\s+account\s+(?:linked|connected))/i;
const NO_TUNNEL = /no\s+matching\s+enabled\s+tunnels|no\s+(?:enabled\s+)?tunnels?\s+(?:found|available)|tunnel\s+not\s+found/i;
const DEVICE_CODE = /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/i;
const ADDRESS_AFTER_LABEL = /\b(?:public\s+)?address\s*:\s*((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?:\d{1,5}|(?:\d{1,3}\.){3}\d{1,3}:\d{1,5})/i;
const PUBLIC_ADDRESS = /\b((?=[a-z0-9.-]*[a-z])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?:\d{1,5})\b/i;
const MAPPING = /\b(UDP|TCP)\s+(\d{1,5})\s*(?:→|->|=>)\s*(\d{1,5})\b/i;

interface CommandResult {
  code: number | null;
  output: string;
  timedOut: boolean;
  spawnError: string | null;
}

export interface PortwarpRunnerOptions {
  binaryCommand?: string;
  tunnelName?: string;
  pollIntervalMs?: number;
  statusTimeoutMs?: number;
  connectTimeoutMs?: number;
}

function cleanOutput(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

export function parsePortwarpAddress(value: string): string | null {
  const output = cleanOutput(value);
  return output.match(ADDRESS_AFTER_LABEL)?.[1]
    ?? output.match(PUBLIC_ADDRESS)?.[1]
    ?? null;
}

export function parsePortwarpMapping(value: string): { protocol: 'UDP' | 'TCP'; localPort: number; publicPort: number } | null {
  const match = cleanOutput(value).match(MAPPING);
  if (!match) return null;
  const localPort = Number(match[2]);
  const publicPort = Number(match[3]);
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65_535) return null;
  if (!Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65_535) return null;
  return { protocol: match[1].toUpperCase() as 'UDP' | 'TCP', localPort, publicPort };
}

export function parsePortwarpTunnelAddress(value: string, tunnelName: string): string | null {
  const output = cleanOutput(value);
  const lines = output.split('\n');
  const normalizedName = tunnelName.trim().toLowerCase();
  for (const line of lines.filter((candidate) => normalizedName && candidate.toLowerCase().includes(normalizedName))) {
    const address = parsePortwarpAddress(line);
    if (address) return address;
  }
  const bedrockRows = lines.filter((line) => /\bUDP\s+19132\s*(?:→|->|=>)\s*\d{1,5}\b/i.test(line));
  if (bedrockRows.length === 1) {
    const address = parsePortwarpAddress(bedrockRows[0] ?? '');
    if (address) return address;
  }
  const addresses = [...output.matchAll(new RegExp(PUBLIC_ADDRESS.source, 'gi'))]
    .map((match) => match[1])
    .filter((address): address is string => Boolean(address));
  const uniqueAddresses = [...new Set(addresses)];
  return uniqueAddresses.length === 1 ? uniqueAddresses[0] ?? null : null;
}

function isLiveBedrockSession(value: string): boolean {
  return cleanOutput(value).split('\n').some((line) =>
    /\b19132\s*(?:→|->|=>)\s*\d{1,5}\b/.test(line) && /\blive\b/i.test(line),
  );
}

function isNoRunningSessions(value: string): boolean {
  return /no\s+running\s+sessions|no\s+active\s+sessions|daemon\s+(?:is\s+)?not\s+running|unable\s+to\s+connect\s+to\s+(?:the\s+)?daemon/i.test(cleanOutput(value));
}

function isAuthenticationError(value: string): boolean {
  return AUTH_ERROR.test(cleanOutput(value));
}

function isMissingTunnel(value: string): boolean {
  return NO_TUNNEL.test(cleanOutput(value));
}

function readInterval(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) >= 5_000 ? value as number : fallback;
}

function isChildRunning(child: ChildProcess | null): child is ChildProcess {
  return Boolean(child && child.exitCode === null && child.signalCode === null);
}

/**
 * Connects the existing Portwarp tunnel through the native CLI. Device codes
 * stay in this in-memory snapshot only; the CLI owns its private ~/.portwarp
 * credential store. The detached Portwarp daemon is deliberately not stopped
 * when the N-Craft panel shuts down.
 */
export class PortwarpRunner {
  private startedOnce = false;
  private shuttingDown = false;
  private operationInFlight = false;
  private loginChild: ChildProcess | null = null;
  private loginOutput = '';
  private loginApproved = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly binaryCommand: string;
  private readonly tunnelName: string;
  private readonly pollIntervalMs: number;
  private readonly statusTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private startedAt: string | null = null;
  private addressDetectedAt: string | null = null;
  private status: PortwarpLifecycle = 'starting';
  private address: string | null = null;
  private localPort: number | null = 19132;
  private publicPort: number | null = null;
  private error: string | null = null;
  private setup: PortwarpLoginSnapshot = {
    phase: 'idle',
    verificationUrl: null,
    userCode: null,
    error: null,
  };

  constructor(
    private readonly state: StateStore,
    options: PortwarpRunnerOptions = {},
  ) {
    this.binaryCommand = options.binaryCommand?.trim() || process.env.PORTWARP_BIN?.trim() || 'pwrp';
    this.tunnelName = options.tunnelName?.trim() || process.env.PORTWARP_TUNNEL_NAME?.trim() || 'Minecraft Bedrock';
    this.pollIntervalMs = readInterval(options.pollIntervalMs ?? Number(process.env.PORTWARP_POLL_INTERVAL_MS), 20_000);
    this.statusTimeoutMs = readInterval(options.statusTimeoutMs, 12_000);
    this.connectTimeoutMs = readInterval(options.connectTimeoutMs, 45_000);
  }

  getSetupSnapshot(): PortwarpLoginSnapshot {
    return { ...this.setup };
  }

  startOnce(): void {
    if (this.startedOnce || this.shuttingDown) return;
    this.startedOnce = true;
    this.startedAt = new Date().toISOString();
    this.address = null;
    this.addressDetectedAt = null;
    this.publicPort = null;
    this.setSetup({ phase: 'idle', verificationUrl: null, userCode: null, error: null });
    void this.setStatus('starting', 'Vérification de Portwarp…', null).then(() => this.ensureConnected());
  }

  /** Retry auth detection, tunnel discovery, and connection from the authenticated dashboard. */
  retry(): void {
    if (this.shuttingDown) throw new Error('Le panneau est en cours d’arrêt.');
    this.startedOnce = true;
    if (isChildRunning(this.loginChild) || this.operationInFlight) return;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    void this.ensureConnected();
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    // Cancel only the device-approval subprocess. Do not send `pwrp stop`:
    // tunnel sessions are independent of Bedrock and survive panel restarts.
    const child = this.loginChild;
    if (isChildRunning(child)) {
      try { child.kill('SIGTERM'); } catch { /* It may have exited already. */ }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (isChildRunning(child)) child.kill('SIGKILL');
          resolve();
        }, 2_000);
        child.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this.loginChild = null;
    this.loginOutput = '';
    this.setSetup({ phase: 'idle', verificationUrl: null, userCode: null, error: null });
  }

  private async ensureConnected(): Promise<void> {
    if (this.shuttingDown || this.operationInFlight || isChildRunning(this.loginChild)) return;
    this.operationInFlight = true;
    try {
      const executable = resolveExecutable(this.binaryCommand);
      if (!executable) {
        await this.setStatus(
          'client_missing',
          `Client Portwarp introuvable (${this.binaryCommand}). Relance ncraft setup pour l’installer.`,
          null,
        );
        this.schedulePoll();
        return;
      }

      const auth = await this.runCommand(executable, ['status'], this.statusTimeoutMs);
      if (this.shuttingDown) return;
      if (isAuthenticationError(auth.output)) {
        await this.requireDeviceApproval(executable);
        return;
      }
      if (auth.spawnError || auth.timedOut || auth.code !== 0) {
        await this.setStatus('failed', this.commandFailure('vérifier la connexion Portwarp', auth), this.address);
        this.schedulePoll();
        return;
      }

      this.setSetup({ phase: 'authenticated', verificationUrl: null, userCode: null, error: null });
      await this.connectTunnel(executable);
    } catch {
      if (!this.shuttingDown) {
        await this.setStatus('failed', 'Impossible de vérifier Portwarp. Réessaie depuis le dashboard.', this.address);
        this.schedulePoll();
      }
    } finally {
      this.operationInFlight = false;
    }
  }

  private async requireDeviceApproval(executable: string): Promise<void> {
    await this.setStatus('authentication_required', 'Autorise ce conteneur depuis ton compte Portwarp.', null);
    if (isChildRunning(this.loginChild)) return;
    this.startDeviceLogin(executable);
  }

  private startDeviceLogin(executable: string): void {
    if (this.shuttingDown || isChildRunning(this.loginChild)) return;
    this.loginOutput = '';
    this.loginApproved = false;
    this.setSetup({ phase: 'starting', verificationUrl: null, userCode: null, error: null });

    const childEnvironment = this.childEnvironment();
    let child: ChildProcess;
    try {
      child = spawn(executable, ['login'], {
        cwd: process.cwd(),
        env: childEnvironment,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
    } catch {
      this.setSetup({ phase: 'failed', verificationUrl: null, userCode: null, error: 'Impossible de lancer l’autorisation Portwarp.' });
      void this.setStatus('failed', 'Impossible de lancer l’autorisation Portwarp.', null);
      this.schedulePoll();
      return;
    }

    this.loginChild = child;
    child.stdout?.on('data', (chunk: Buffer) => this.consumeLoginOutput(chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.consumeLoginOutput(chunk));
    child.once('error', () => {
      if (this.loginChild !== child || this.shuttingDown) return;
      this.loginChild = null;
      this.setSetup({ phase: 'failed', verificationUrl: null, userCode: null, error: 'Impossible de lancer pwrp login.' });
      void this.setStatus('failed', 'Impossible de lancer pwrp login.', null);
      this.schedulePoll();
    });
    child.once('close', (code, signal) => {
      if (this.loginChild === child) this.loginChild = null;
      if (this.shuttingDown) return;
      const approved = this.loginApproved || code === 0;
      this.loginOutput = '';
      this.loginApproved = false;
      if (approved) {
        this.setSetup({ phase: 'authenticated', verificationUrl: null, userCode: null, error: null });
        void this.setStatus('starting', 'Compte Portwarp autorisé; connexion du tunnel…', null).then(() => this.ensureConnected());
        return;
      }
      const detail = signal ? ` (signal ${signal})` : code === null ? '' : ` (code ${code})`;
      this.setSetup({ phase: 'failed', verificationUrl: null, userCode: null, error: `Autorisation Portwarp interrompue${detail}. Réessaie depuis le dashboard.` });
      void this.setStatus('authentication_required', 'L’autorisation Portwarp doit être terminée.', null);
      this.schedulePoll();
    });
  }

  private consumeLoginOutput(chunk: Buffer): void {
    // Never log or persist CLI output: it contains the one-time device code and may
    // include account details. Keep a short private in-memory buffer for parsing only.
    this.loginOutput = `${this.loginOutput}${chunk.toString('utf8')}`.slice(-8_000);
    const cleaned = cleanOutput(this.loginOutput);
    const code = cleaned.match(DEVICE_CODE)?.[0] ?? null;
    const approved = /\bapproved\b/i.test(cleaned);
    if (approved) this.loginApproved = true;
    if (code) {
      this.setSetup({
        phase: approved ? 'authenticated' : 'waiting_for_approval',
        verificationUrl: DEVICE_URL,
        userCode: approved ? null : code,
        error: null,
      });
      void this.setStatus(
        approved ? 'starting' : 'awaiting_approval',
        approved ? 'Autorisation Portwarp reçue; connexion du tunnel…' : 'Entre le code temporaire sur Portwarp pour lier ce conteneur.',
        null,
      );
    }
  }

  private async connectTunnel(executable: string): Promise<void> {
    if (this.shuttingDown) return;
    await this.setStatus('connecting', `Connexion au tunnel Portwarp « ${this.tunnelName} »…`, this.address);
    const result = await this.runCommand(
      executable,
      ['connect', this.tunnelName, '--save', '--detach'],
      this.connectTimeoutMs,
    );
    if (this.shuttingDown) return;

    if (isAuthenticationError(result.output)) {
      await this.requireDeviceApproval(executable);
      return;
    }
    if (isMissingTunnel(result.output)) {
      await this.setStatus(
        'tunnel_missing',
        `Tunnel « ${this.tunnelName} » introuvable ou désactivé. Crée/active dans Portwarp un tunnel UDP vers 19132; N-Craft réessaiera automatiquement.`,
        null,
      );
      this.schedulePoll();
      return;
    }
    if (result.spawnError || result.timedOut || result.code !== 0) {
      await this.setStatus('failed', this.commandFailure('connecter le tunnel Portwarp', result), this.address);
      this.schedulePoll();
      return;
    }

    const mapping = parsePortwarpMapping(result.output);
    if (mapping && (mapping.protocol !== 'UDP' || mapping.localPort !== 19_132)) {
      this.localPort = mapping.localPort;
      this.publicPort = mapping.publicPort;
      await this.setStatus(
        'tunnel_misconfigured',
        `Le tunnel « ${this.tunnelName} » est ${mapping.protocol} ${mapping.localPort} → ${mapping.publicPort}; Bedrock exige UDP 19132. Corrige la règle dans Portwarp.`,
        null,
      );
      this.schedulePoll();
      return;
    }

    const address = parsePortwarpAddress(result.output)
      ?? this.address
      ?? await this.lookupPublicAddress(executable);
    if (mapping) {
      this.localPort = mapping.localPort;
      this.publicPort = mapping.publicPort;
    }
    await this.setStatus(
      'running',
      mapping ? null : 'Le tunnel est connecté; l’adresse est détectée, mais le CLI n’a pas confirmé la règle UDP 19132.',
      address,
    );
    this.schedulePoll();
  }

  private async lookupPublicAddress(executable: string): Promise<string | null> {
    const listing = await this.runCommand(executable, ['tunnels'], this.statusTimeoutMs);
    if (listing.code !== 0 || listing.timedOut || listing.spawnError || isAuthenticationError(listing.output)) return null;
    return parsePortwarpTunnelAddress(listing.output, this.tunnelName);
  }

  private async poll(): Promise<void> {
    if (this.shuttingDown || this.operationInFlight || isChildRunning(this.loginChild)) return;
    const executable = resolveExecutable(this.binaryCommand);
    if (!executable) {
      await this.setStatus('client_missing', `Client Portwarp introuvable (${this.binaryCommand}). Relance ncraft setup pour l’installer.`, null);
      this.schedulePoll();
      return;
    }

    this.operationInFlight = true;
    try {
      const result = await this.runCommand(executable, ['ps', '--once'], this.statusTimeoutMs);
      if (this.shuttingDown) return;
      if (isAuthenticationError(result.output)) {
        await this.requireDeviceApproval(executable);
        return;
      }
      if (isLiveBedrockSession(result.output)) {
        const address = parsePortwarpAddress(result.output)
          ?? this.address
          ?? await this.lookupPublicAddress(executable);
        const mapping = parsePortwarpMapping(result.output);
        if (mapping && (mapping.protocol !== 'UDP' || mapping.localPort !== 19_132)) {
          this.localPort = mapping.localPort;
          this.publicPort = mapping.publicPort;
          await this.setStatus(
            'tunnel_misconfigured',
            `Le tunnel « ${this.tunnelName} » est ${mapping.protocol} ${mapping.localPort} → ${mapping.publicPort}; Bedrock exige UDP 19132. Corrige la règle dans Portwarp.`,
            null,
          );
          this.schedulePoll();
          return;
        }
        if (mapping) {
          this.localPort = mapping.localPort;
          this.publicPort = mapping.publicPort;
        }
        await this.setStatus('running', null, address);
        this.schedulePoll();
        return;
      }
      if (isNoRunningSessions(result.output) || result.code === 0) {
        await this.connectTunnel(executable);
        return;
      }
      await this.setStatus('failed', this.commandFailure('vérifier le tunnel Portwarp', result), this.address);
      this.schedulePoll();
    } catch {
      if (!this.shuttingDown) {
        await this.setStatus('failed', 'Impossible de vérifier le tunnel Portwarp. Réessaie depuis le dashboard.', this.address);
        this.schedulePoll();
      }
    } finally {
      this.operationInFlight = false;
    }
  }

  private async runCommand(executable: string, args: string[], timeoutMs: number): Promise<CommandResult> {
    return new Promise((resolve) => {
      let output = '';
      let timedOut = false;
      let spawnError: string | null = null;
      let settled = false;
      let killTimer: NodeJS.Timeout | null = null;
      let child: ChildProcess;
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        resolve({ code, output: cleanOutput(output), timedOut, spawnError });
      };
      const append = (chunk: Buffer) => {
        output = `${output}${chunk.toString('utf8')}`.slice(-MAX_OUTPUT_CHARS);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch { /* It may have exited. */ }
        killTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* It may have exited. */ }
        }, 1_500);
      }, timeoutMs);
      timer.unref?.();
      try {
        child = spawn(executable, args, {
          cwd: process.cwd(),
          env: this.childEnvironment(),
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
          windowsHide: true,
        });
      } catch (error) {
        spawnError = (error as Error).message;
        finish(null);
        return;
      }
      child.stdout?.on('data', append);
      child.stderr?.on('data', append);
      child.once('error', (error) => {
        spawnError = error.message;
        finish(null);
      });
      child.once('close', (code) => finish(code));
    });
  }

  private childEnvironment(): NodeJS.ProcessEnv {
    return buildChildEnvironment();
  }

  private commandFailure(action: string, result: CommandResult): string {
    if (result.timedOut) return `Délai dépassé pour ${action}; le panneau réessaiera automatiquement.`;
    if (result.spawnError) return `Impossible de lancer pwrp pour ${action}. Vérifie son installation.`;
    if (isAuthenticationError(result.output)) return 'Autorisation Portwarp requise; suis le lien affiché dans le dashboard.';
    if (isMissingTunnel(result.output)) return `Tunnel « ${this.tunnelName} » introuvable ou désactivé dans Portwarp.`;
    return `Échec pour ${action} (code ${result.code ?? 'inconnu'}). Vérifie le tunnel dans Portwarp; un nouvel essai sera tenté.`;
  }

  private async setStatus(status: PortwarpLifecycle, error: string | null, address: string | null): Promise<void> {
    this.status = status;
    this.error = error;
    this.address = address;
    if (address) this.addressDetectedAt ??= new Date().toISOString();
    else if (status === 'authentication_required' || status === 'tunnel_missing') {
      this.addressDetectedAt = null;
      this.publicPort = null;
    } else if (status === 'tunnel_misconfigured') {
      this.addressDetectedAt = null;
    }
    await this.state.updatePortwarp({
      status,
      address,
      error,
      tunnelName: this.tunnelName,
      localPort: this.localPort,
      publicPort: this.publicPort,
      startedAt: this.startedAt,
      addressDetectedAt: address ? this.addressDetectedAt : null,
    }).catch((persistError) => {
      console.error(`[portwarp] Impossible de sauvegarder l’état du tunnel : ${(persistError as Error).message}`);
    });
  }

  private setSetup(snapshot: PortwarpLoginSnapshot): void {
    this.setup = { ...snapshot };
  }

  private schedulePoll(delayMs = this.pollIntervalMs): void {
    if (this.shuttingDown || isChildRunning(this.loginChild)) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll();
    }, delayMs);
    this.pollTimer.unref?.();
  }
}
