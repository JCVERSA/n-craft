import { randomUUID } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import type { PanelAuthService } from '../auth.ts';
import type { StateStore } from '../state.ts';
import type { ConsoleLog, LogLevel } from '../types/backend.ts';
import { isSameOriginRequest } from '../security.ts';

const MAX_RECENT_LINES = 500;
const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024;
const COMMAND_MAX_LENGTH = 1000;

interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  wasReady: boolean;
  intentional: boolean;
}

interface StartOptions {
  binaryPath: string;
  workingDirectory: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onEulaPrompt: () => void;
}

class BoundedLogFile {
  private stream: WriteStream | null = null;
  private sizeBytes = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  append(line: string): void {
    const content = Buffer.from(`${line}\n`, 'utf8');
    const write = this.queue.then(async () => {
      await this.ensureOpen();
      if (this.sizeBytes + content.byteLength > MAX_LOG_FILE_BYTES) await this.rotate();
      await new Promise<void>((resolve, reject) => {
        this.stream!.write(content, (error?: Error | null) => error ? reject(error) : resolve());
      });
      this.sizeBytes += content.byteLength;
    });
    this.queue = write.catch((error) => {
      console.error(`[console] Could not write server log: ${(error as Error).message}`);
    });
  }

  async close(): Promise<void> {
    await this.queue;
    const stream = this.stream;
    this.stream = null;
    if (!stream) return;
    await new Promise<void>((resolve) => stream.end(() => resolve()));
  }

  private async ensureOpen(): Promise<void> {
    if (this.stream) return;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const current = await stat(this.filePath);
      this.sizeBytes = current.size;
      if (this.sizeBytes > MAX_LOG_FILE_BYTES) {
        await this.rotateExistingFile();
        this.sizeBytes = 0;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.sizeBytes = 0;
    }
    this.stream = createWriteStream(this.filePath, { flags: 'a', mode: 0o600 });
  }

  private async rotate(): Promise<void> {
    const stream = this.stream;
    this.stream = null;
    if (stream) await new Promise<void>((resolve) => stream.end(() => resolve()));
    await this.rotateExistingFile();
    this.stream = createWriteStream(this.filePath, { flags: 'a', mode: 0o600 });
    this.sizeBytes = 0;
  }

  private async rotateExistingFile(): Promise<void> {
    await rm(`${this.filePath}.1`, { force: true });
    await rename(this.filePath, `${this.filePath}.1`).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

/** Owns only the Bedrock child process and its console stream. */
export class BedrockConsole extends EventEmitter {
  private child: ChildProcess | null = null;
  private ready = false;
  private recentLines: ConsoleLog[] = [];
  private readonly logFile: BoundedLogFile;
  private readonly readyChildren = new WeakSet<ChildProcess>();
  private readonly intentionalStops = new WeakSet<ChildProcess>();
  private readonly closedChildren = new WeakSet<ChildProcess>();
  private stopPromise: Promise<void> | null = null;

  constructor(dataDirectory: string) {
    super();
    this.logFile = new BoundedLogFile(path.join(dataDirectory, 'server.log'));
  }

  get isRunning(): boolean {
    return Boolean(this.child && this.child.pid !== undefined && this.child.exitCode === null && this.child.signalCode === null);
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get isReady(): boolean {
    return this.ready && this.isRunning;
  }

  getRecentLines(): ConsoleLog[] {
    return this.recentLines.map((line) => ({ ...line }));
  }

  async start(options: StartOptions): Promise<void> {
    if (this.isRunning) throw new Error('bedrock_server est déjà en cours d’exécution.');
    this.ready = false;

    const existingLibraryPath = process.env.LD_LIBRARY_PATH;
    const environment: NodeJS.ProcessEnv = { ...process.env };
    delete environment.PANEL_TOKEN;
    delete environment.PLAYIT_SECRET_KEY;
    environment.LD_LIBRARY_PATH = existingLibraryPath
      ? `${options.workingDirectory}${path.delimiter}${existingLibraryPath}`
      : options.workingDirectory;

    let child: ChildProcess;
    try {
      child = spawn(options.binaryPath, [], {
        cwd: options.workingDirectory,
        env: environment,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      throw new Error(`Impossible de lancer bedrock_server : ${(error as Error).message}`);
    }
    this.child = child;

    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const pendingLines: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
    let rollingOutput = '';
    let eulaAnswered = false;
    let settled = false;

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        fail(new Error(`bedrock_server n’a pas confirmé son démarrage après ${Math.round(options.timeoutMs / 1000)} secondes.`));
      }, options.timeoutMs);

      const onAbort = () => {
        const reason = options.signal?.reason;
        fail(reason instanceof Error ? reason : new Error('Démarrage Bedrock annulé.'));
      };
      const cleanStartListeners = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };

      const succeed = () => {
        if (settled) return;
        settled = true;
        if (this.child === child && child.exitCode === null && child.signalCode === null) {
          this.readyChildren.add(child);
          this.ready = true;
        }
        cleanStartListeners();
        resolve();
      };

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanStartListeners();
        reject(error);
      };

      const consumeText = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
        const decoded = decoders[stream].write(chunk);
        if (!decoded) return;
        rollingOutput = `${rollingOutput}${decoded}`.slice(-6000);
        pendingLines[stream] += decoded;

        if (!eulaAnswered && this.isEulaPrompt(rollingOutput)) {
          eulaAnswered = true;
          try {
            child.stdin?.write('y\n');
            options.onEulaPrompt();
            this.appendLine('EULA', 'Prompt EULA reconnu ; réponse automatique « y » envoyée.', 'warn');
          } catch (error) {
            this.appendLine('EULA', `Échec de l’envoi de la réponse EULA : ${(error as Error).message}`, 'error');
          }
        }

        const buffer = pendingLines[stream];
        const parts = buffer.split(/\r?\n/);
        pendingLines[stream] = parts.pop() ?? '';
        for (const line of parts) this.consumeLine(line, stream);

        if (pendingLines[stream].length > 16_384) {
          this.consumeLine(pendingLines[stream].slice(0, 16_384), stream);
          pendingLines[stream] = pendingLines[stream].slice(16_384);
        }

        if (this.isReadyMessage(rollingOutput)) succeed();
      };

      child.stdout?.on('data', (chunk: Buffer) => consumeText('stdout', chunk));
      child.stderr?.on('data', (chunk: Buffer) => consumeText('stderr', chunk));

      child.once('error', (error) => {
        this.appendLine('PROCESS', `Erreur du processus Bedrock : ${error.message}`, 'error');
        fail(new Error(`Impossible de lancer bedrock_server : ${error.message}`));
      });

      child.once('close', (code, signal) => {
        this.closedChildren.add(child);
        for (const stream of ['stdout', 'stderr'] as const) {
          const tail = pendingLines[stream] + decoders[stream].end();
          if (tail.trim()) this.consumeLine(tail, stream);
        }
        const wasReady = this.readyChildren.has(child);
        const intentional = this.intentionalStops.has(child);
        if (this.child === child) {
          this.child = null;
          this.ready = false;
        }
        const description = signal ? `signal ${signal}` : `code ${code ?? 'inconnu'}`;
        const level: LogLevel = code === 0 || intentional ? 'warn' : 'error';
        this.appendLine('PROCESS', `bedrock_server arrêté (${description}).`, level);
        const exit: ProcessExit = { code, signal, wasReady, intentional };
        this.emit('exit', exit);
        if (!settled) fail(new Error(`bedrock_server s’est arrêté avant d’être prêt (${description}).`));
      });

      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  sendCommand(command: string): boolean {
    if (!this.isReady || !this.child?.stdin || this.child.stdin.destroyed || !this.child.stdin.writable) return false;
    if (!command || command.length > COMMAND_MAX_LENGTH || /[\r\n\0]/.test(command)) return false;
    try {
      this.child.stdin.write(`${command}\n`);
      this.appendLine('CONSOLE', `> ${command}`, 'exec');
      return true;
    } catch {
      return false;
    }
  }

  async stop(timeoutMs: number): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const stopPromise = this.performStop(timeoutMs);
    this.stopPromise = stopPromise;
    try {
      await stopPromise;
    } finally {
      if (this.stopPromise === stopPromise) this.stopPromise = null;
    }
  }

  private async performStop(timeoutMs: number): Promise<void> {
    const child = this.child;
    if (!child) {
      this.ready = false;
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      this.ready = false;
      await this.waitForExit(child, 5000);
      return;
    }

    this.intentionalStops.add(child);
    const sentGracefulCommand = this.sendCommand('stop');
    this.ready = false;

    const gracefulWaitMs = sentGracefulCommand ? Math.max(250, Math.floor(timeoutMs / 2)) : 0;
    if (sentGracefulCommand && await this.waitForExit(child, gracefulWaitMs)) return;

    if (sentGracefulCommand) {
      this.appendLine('PROCESS', 'La commande console « stop » n’a pas arrêté Bedrock ; envoi de SIGTERM.', 'warn');
    }
    try {
      child.kill('SIGTERM');
    } catch {
      // Continue to the bounded wait and SIGKILL fallback.
    }

    const termWaitMs = sentGracefulCommand ? Math.max(250, timeoutMs - gracefulWaitMs) : timeoutMs;
    if (await this.waitForExit(child, termWaitMs)) return;

    this.appendLine('PROCESS', 'Aucun arrêt après SIGTERM ; envoi de SIGKILL.', 'warn');
    try {
      child.kill('SIGKILL');
    } catch {
      // The child may have exited between the timeout and kill.
    }
    const killed = await this.waitForExit(child, 5000);
    if (!killed && child.exitCode === null && child.signalCode === null) {
      throw new Error('bedrock_server est toujours actif après SIGKILL ; Wipe/arrêt annulé pour protéger les données.');
    }
  }

  async close(): Promise<void> {
    await this.logFile.close();
  }

  private async waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (this.closedChildren.has(child)) return true;
    return new Promise<boolean>((resolve) => {
      let finished = false;
      let timer: NodeJS.Timeout;
      const finish = (closed: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        child.removeListener('close', onClose);
        resolve(closed || this.closedChildren.has(child) || child.exitCode !== null || child.signalCode !== null);
      };
      const onClose = () => finish(true);
      child.once('close', onClose);
      timer = setTimeout(() => finish(false), timeoutMs);
      if (this.closedChildren.has(child)) finish(true);
    });
  }

  private isEulaPrompt(text: string): boolean {
    return /(?:do you (?:agree to|accept).{0,100}(?:eula|end user license)|(?:eula|end user license).{0,100}(?:agree|accept).{0,50}(?:\?|\by\/n\b|yes\/no))/is.test(text);
  }

  private isReadyMessage(text: string): boolean {
    return /\bserver started\b|ipv4 supported, port:\s*19132|listening on (?:udp )?port\s*19132/i.test(text);
  }

  private consumeLine(rawLine: string, stream: 'stdout' | 'stderr'): void {
    const message = rawLine.replace(/\0/g, '').trimEnd();
    if (!message.trim()) return;
    const level: LogLevel = /\b(error|fatal|failed|exception)\b/i.test(message)
      ? 'error'
      : /\b(warn|warning)\b/i.test(message)
        ? 'warn'
        : 'info';
    this.appendLine(stream === 'stderr' ? 'BDS STDERR' : 'BDS', message, level);
  }

  private appendLine(tag: string, message: string, level: LogLevel): void {
    const line: ConsoleLog = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      tag,
      message,
      level,
    };
    this.recentLines.push(line);
    if (this.recentLines.length > MAX_RECENT_LINES) this.recentLines.splice(0, this.recentLines.length - MAX_RECENT_LINES);
    this.logFile.append(`${line.timestamp} [${line.tag}] ${line.message}`);
    this.emit('line', { ...line });
  }
}

function sendUpgradeError(socket: import('node:stream').Duplex, status: number, message: string): void {
  const label = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Not Found';
  socket.write(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${message}`);
  socket.destroy();
}

/** Authenticated WebSocket bridge. The browser never gets process or shell access. */
export function attachConsoleWebSocket(
  httpServer: HttpServer,
  auth: PanelAuthService,
  bedrockConsole: BedrockConsole,
  stateStore: StateStore,
): { close: () => Promise<void> } {
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });

  const onUpgrade = (request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
    const host = request.headers.host;
    if (!host) return sendUpgradeError(socket, 404, 'Not found');
    let pathname: string;
    try {
      pathname = new URL(request.url ?? '/', `http://${host}`).pathname;
    } catch {
      return sendUpgradeError(socket, 404, 'Not found');
    }
    if (pathname !== '/api/server/console') {
      socket.destroy();
      return;
    }

    // WebSocket upgrades do not pass through Express middleware. Re-check both
    // the HttpOnly session cookie and Origin before accepting the upgrade.
    const requestLike = request as unknown as import('express').Request;
    if (!auth.isAuthenticated(requestLike)) return sendUpgradeError(socket, 401, 'Authentication required');
    if (!isSameOriginRequest(requestLike)) return sendUpgradeError(socket, 403, 'Invalid origin');

    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit('connection', webSocket, request);
    });
  };

  httpServer.on('upgrade', onUpgrade);
  webSocketServer.on('connection', (webSocket) => {
    const send = (payload: unknown) => {
      if (webSocket.readyState === WebSocket.OPEN) webSocket.send(JSON.stringify(payload));
    };
    send({ type: 'snapshot', lines: bedrockConsole.getRecentLines(), state: stateStore.getSnapshot() });

    const onLine = (line: ConsoleLog) => send({ type: 'line', line });
    const onState = (state: ReturnType<StateStore['getSnapshot']>) => send({ type: 'state', state });
    bedrockConsole.on('line', onLine);
    stateStore.on('change', onState);

    webSocket.on('message', (data) => {
      let message: unknown;
      try {
        message = JSON.parse(data.toString()) as unknown;
      } catch {
        send({ type: 'error', error: 'Message JSON invalide.' });
        return;
      }
      if (typeof message !== 'object' || message === null || (message as { type?: unknown }).type !== 'command') {
        send({ type: 'error', error: 'Type de message non pris en charge.' });
        return;
      }
      const command = (message as { command?: unknown }).command;
      if (typeof command !== 'string' || !command.trim() || command.length > COMMAND_MAX_LENGTH || /[\r\n\0]/.test(command)) {
        send({ type: 'error', error: 'Commande invalide : une seule ligne de 1 000 caractères maximum est acceptée.' });
        return;
      }
      if (!bedrockConsole.sendCommand(command.trim())) {
        send({ type: 'error', error: 'Le serveur Bedrock n’est pas prêt ou la console est fermée.' });
      }
    });

    webSocket.once('close', () => {
      bedrockConsole.removeListener('line', onLine);
      stateStore.removeListener('change', onState);
    });
    webSocket.once('error', () => {
      bedrockConsole.removeListener('line', onLine);
      stateStore.removeListener('change', onState);
    });
  });

  return {
    close: async () => {
      httpServer.removeListener('upgrade', onUpgrade);
      const clients = [...webSocketServer.clients];
      const closed = new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
      for (const client of clients) client.close(1001, 'Panel shutting down');
      const terminateTimer = setTimeout(() => {
        for (const client of clients) {
          if (client.readyState !== WebSocket.CLOSED) client.terminate();
        }
      }, 1000);
      terminateTimer.unref();
      try {
        await closed;
      } finally {
        clearTimeout(terminateTimer);
      }
    },
  };
}
