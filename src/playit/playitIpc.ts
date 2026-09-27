import { EventEmitter } from 'node:events';
import { createConnection, type Socket } from 'node:net';

const IPC_VERSION = 2;
const MAX_IPC_LINE_BYTES = 1024 * 1024;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Playit IPC operation aborted.');
}

interface LineWaiter {
  resolve: (line: string) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  timer?: NodeJS.Timeout;
}

/** Minimal client for Playit Agent 1.x's documented newline-delimited local IPC. */
export class PlayitIpcClient extends EventEmitter {
  private bufferedText = '';
  private readonly queuedLines: string[] = [];
  private readonly waiters: LineWaiter[] = [];
  private failure: Error | null = null;

  private constructor(private readonly socket: Socket) {
    super();
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.consumeText(chunk));
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => this.fail(new Error('Playit daemon closed its IPC socket.')));
  }

  static async connect(
    socketPath: string,
    signal: AbortSignal,
    timeoutMs = 1000,
  ): Promise<PlayitIpcClient> {
    const socket = createConnection({ path: socketPath });
    const client = new PlayitIpcClient(socket);
    try {
      await client.waitForConnect(signal, timeoutMs);
      const hello = await client.readJson(signal, timeoutMs);
      const data = isRecord(hello) && isRecord(hello.data) ? hello.data : null;
      const protocol = data && isRecord(data.protocol) ? data.protocol : null;
      if (
        !isRecord(hello) ||
        hello.message_kind !== 'hello' ||
        !protocol ||
        protocol.ipc_version !== IPC_VERSION
      ) {
        throw new Error('Playit daemon sent an unsupported IPC hello/version.');
      }
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  async subscribe(signal: AbortSignal, timeoutMs = 5000): Promise<unknown> {
    this.writeJson({
      ipc_version: IPC_VERSION,
      request_id: 1,
      request: { type: 'subscribe' },
    });
    const deadline = Date.now() + timeoutMs;

    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Timed out waiting for a Playit IPC subscribe response.');
      const envelope = await this.readJson(signal, remaining);
      if (!isRecord(envelope)) throw new Error('Invalid Playit IPC response.');
      if (envelope.message_kind === 'event') {
        this.emitEvent(envelope.data);
        continue;
      }
      if (envelope.message_kind !== 'response' || !isRecord(envelope.data)) {
        throw new Error('Playit daemon sent an unexpected IPC envelope while subscribing.');
      }
      if (envelope.data.ipc_version !== IPC_VERSION) throw new Error('Playit daemon changed its IPC version.');
      if (envelope.data.request_id !== 1 || !isRecord(envelope.data.response)) {
        throw new Error('Playit daemon returned a mismatched IPC response.');
      }
      const response = envelope.data.response;
      if (response.type === 'error') {
        const data = isRecord(response.data) ? response.data : {};
        throw new Error(typeof data.message === 'string' ? data.message : 'Playit IPC subscribe request failed.');
      }
      if (response.type !== 'subscribe') throw new Error('Playit daemon rejected the IPC subscribe request.');
      return response.data;
    }
  }

  async monitor(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const envelope = await this.readJson(signal);
      if (!isRecord(envelope)) throw new Error('Playit daemon sent an invalid IPC envelope.');
      if (envelope.message_kind === 'event') this.emitEvent(envelope.data);
      else throw new Error('Playit daemon sent an unexpected IPC envelope while streaming events.');
    }
  }

  close(): void {
    this.fail(new Error('Playit IPC client closed.'));
    if (!this.socket.destroyed) this.socket.destroy();
  }

  private emitEvent(data: unknown): void {
    if (!isRecord(data) || data.ipc_version !== IPC_VERSION || !isRecord(data.event) || typeof data.event.type !== 'string') {
      throw new Error('Playit daemon sent an invalid IPC event.');
    }
    this.emit(data.event.type, data.event.data);
  }

  private writeJson(value: unknown): void {
    if (this.socket.destroyed || !this.socket.writable) throw new Error('Playit IPC socket is not writable.');
    this.socket.write(`${JSON.stringify(value)}\n`);
  }

  private async waitForConnect(signal: AbortSignal, timeoutMs: number): Promise<void> {
    if (signal.aborted) throw abortError(signal);
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const timer = setTimeout(() => finish(new Error('Timed out connecting to the Playit IPC socket.')), timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.socket.removeListener('connect', onConnect);
        this.socket.removeListener('error', onError);
        signal.removeEventListener('abort', onAbort);
      };
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onConnect = () => finish();
      const onError = (error: Error) => finish(error);
      const onAbort = () => finish(abortError(signal));
      this.socket.once('connect', onConnect);
      this.socket.once('error', onError);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async readJson(signal: AbortSignal, timeoutMs?: number): Promise<unknown> {
    const line = await this.nextLine(signal, timeoutMs);
    try {
      return JSON.parse(line) as unknown;
    } catch {
      throw new Error('Playit daemon sent invalid JSON over IPC.');
    }
  }

  private nextLine(signal: AbortSignal, timeoutMs?: number): Promise<string> {
    if (signal.aborted) return Promise.reject(abortError(signal));
    const queued = this.queuedLines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);

    return new Promise<string>((resolve, reject) => {
      const waiter: LineWaiter = { resolve, reject, signal };
      const cleanup = () => {
        if (waiter.timer) clearTimeout(waiter.timer);
        if (waiter.onAbort) signal.removeEventListener('abort', waiter.onAbort);
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
      };
      waiter.resolve = (line) => { cleanup(); resolve(line); };
      waiter.reject = (error) => { cleanup(); reject(error); };
      waiter.onAbort = () => waiter.reject(abortError(signal));
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      if (timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => waiter.reject(new Error('Timed out waiting for a Playit IPC response.')), timeoutMs);
      }
      this.waiters.push(waiter);
      if (this.failure) waiter.reject(this.failure);
    });
  }

  private consumeText(text: string): void {
    this.bufferedText += text;
    if (Buffer.byteLength(this.bufferedText, 'utf8') > MAX_IPC_LINE_BYTES && !this.bufferedText.includes('\n')) {
      this.fail(new Error('Playit IPC line exceeded the size limit.'));
      this.socket.destroy();
      return;
    }
    while (true) {
      const newline = this.bufferedText.indexOf('\n');
      if (newline < 0) break;
      const line = this.bufferedText.slice(0, newline).replace(/\r$/, '');
      this.bufferedText = this.bufferedText.slice(newline + 1);
      if (Buffer.byteLength(line, 'utf8') > MAX_IPC_LINE_BYTES) {
        this.fail(new Error('Playit IPC line exceeded the size limit.'));
        this.socket.destroy();
        return;
      }
      if (line) this.pushLine(line);
    }
    if (Buffer.byteLength(this.bufferedText, 'utf8') > MAX_IPC_LINE_BYTES) {
      this.fail(new Error('Playit IPC line exceeded the size limit.'));
      this.socket.destroy();
    }
  }

  private pushLine(line: string): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(line);
    else this.queuedLines.push(line);
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const waiter of [...this.waiters]) waiter.reject(error);
  }
}
