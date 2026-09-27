import { chmod, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { BedrockConsole } from './console.ts';
import { downloadBedrockArchive } from './download.ts';
import { extractZipSafely } from './extractArchive.ts';
import { writeBedrockConfiguration } from './configWriter.ts';
import { getMaxArchiveBytes } from './limits.ts';
import { mergeBedrockRelease } from './installRelease.ts';
import { SystemInspector } from '../preflight.ts';
import { StateStore } from '../state.ts';
import type { DeployConfiguration, PipelineStep, VersionEntry } from '../types/backend.ts';

export class DeployInProgressError extends Error {
  constructor() {
    super('Une opération Bedrock est déjà en cours. Attends sa fin avant d’en lancer une autre.');
    this.name = 'DeployInProgressError';
  }
}

export class ServerNotInstalledError extends Error {
  constructor() {
    super('Aucun serveur Bedrock prêt à démarrer. Effectue d’abord un Deploy depuis le dashboard.');
    this.name = 'ServerNotInstalledError';
  }
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertSafeServerDirectory(serverDirectory: string, dataDirectory: string): void {
  const target = path.resolve(serverDirectory);
  const filesystemRoot = path.parse(target).root;
  const projectRoot = path.resolve(process.cwd());
  const relativeToProject = path.relative(projectRoot, target);
  const insideProject = relativeToProject !== '' && !relativeToProject.startsWith(`..${path.sep}`) && relativeToProject !== '..' && !path.isAbsolute(relativeToProject);
  const overlapsData = isWithin(target, dataDirectory) || isWithin(dataDirectory, target);
  if (
    target === filesystemRoot ||
    isWithin(target, projectRoot) ||
    overlapsData ||
    path.basename(target) !== 'server' ||
    (insideProject && relativeToProject !== path.join('bedrock', 'server'))
  ) {
    throw new Error(`BEDROCK_SERVER_DIR refuse un emplacement dangereux : ${target}`);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error('Déploiement annulé.');
}

async function assertNoSymlinkInPath(directory: string): Promise<void> {
  let current = path.resolve(directory);
  while (true) {
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info?.isSymbolicLink()) throw new Error(`Le chemin ${current} contient un lien symbolique ; mise à jour refusée.`);
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

/** One exclusive, non-destructive deployment pipeline; Playit is intentionally not a dependency. */
export class DeployPipeline {
  private active = false;
  private shuttingDown = false;
  private activeRun: Promise<void> | null = null;
  private activeController: AbortController | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private readonly serverDirectory: string;
  private readonly stopTimeoutMs: number;
  private readonly startTimeoutMs: number;

  constructor(
    private readonly state: StateStore,
    private readonly bedrockConsole: BedrockConsole,
    private readonly inspector: SystemInspector,
    private readonly dataDirectory: string,
    serverDirectory: string,
    private readonly findVersion: (version: string) => VersionEntry | undefined,
    private readonly artifacts: {
      download: typeof downloadBedrockArchive;
      extract: typeof extractZipSafely;
    } = { download: downloadBedrockArchive, extract: extractZipSafely },
  ) {
    this.serverDirectory = path.resolve(serverDirectory);
    this.stopTimeoutMs = this.readTimeout('BDS_STOP_TIMEOUT_MS', 10_000);
    this.startTimeoutMs = this.readTimeout('BDS_START_TIMEOUT_MS', 60_000);
    assertSafeServerDirectory(this.serverDirectory, dataDirectory);
  }

  get isRunning(): boolean {
    return this.active;
  }

  get serverDirectoryPath(): string {
    return this.serverDirectory;
  }

  /** Start without holding the HTTP request open for the full download/extract. */
  start(configuration: DeployConfiguration): void {
    if (this.active || this.shuttingDown) throw new DeployInProgressError();
    this.active = true;
    const controller = new AbortController();
    this.activeController = controller;
    const runPromise = this.run(configuration, controller.signal);
    this.activeRun = runPromise;
    void runPromise.then(
      () => this.finishRun(runPromise),
      (error) => {
        this.finishRun(runPromise);
        console.error(`[deploy] Unhandled pipeline failure: ${(error as Error).message}`);
      },
    );
  }

  /** Restart an already deployed server without touching its world or configuration. */
  startExisting(): void {
    if (this.active || this.shuttingDown) throw new DeployInProgressError();

    this.active = true;
    const controller = new AbortController();
    this.activeController = controller;
    const runPromise = this.runExistingStart(controller.signal);
    this.activeRun = runPromise;
    void runPromise.then(
      () => this.finishRun(runPromise),
      (error) => {
        this.finishRun(runPromise);
        console.error(`[start] Unhandled Bedrock start failure: ${(error as Error).message}`);
      },
    );
  }

  /** Atomic stop/start operation used by the scheduled restart countdown. */
  restartExisting(): Promise<void> {
    if (this.active || this.shuttingDown) throw new DeployInProgressError();
    if (!this.bedrockConsole.isReady) throw new Error('Le redémarrage planifié a été annulé : Bedrock n’est plus en ligne.');
    if (!this.state.getSnapshot().activeConfig) throw new ServerNotInstalledError();

    this.active = true;
    const controller = new AbortController();
    this.activeController = controller;
    const runPromise = this.runExistingRestart(controller.signal);
    this.activeRun = runPromise;
    return runPromise.finally(() => this.finishRun(runPromise));
  }

  async stop(): Promise<void> {
    if (this.active || this.shuttingDown) throw new DeployInProgressError();
    this.active = true;
    const runPromise = this.performStop();
    this.activeRun = runPromise;
    try {
      await runPromise;
    } finally {
      this.finishRun(runPromise);
    }
  }

  private async performStop(): Promise<void> {
    await this.state.updateServer({ status: 'stopping', error: null });
    try {
      await this.bedrockConsole.stop(this.stopTimeoutMs);
      await this.state.updateServer({
        status: 'stopped',
        pid: null,
        startedAt: null,
        error: null,
        playersOnline: 0,
        cpuPercent: null,
        memoryBytes: null,
        metricsUpdatedAt: null,
      });
    } catch (error) {
      const stillRunning = this.bedrockConsole.isRunning;
      const previous = this.state.getSnapshot().server;
      await this.state.updateServer({
        status: stillRunning ? 'failed' : 'stopped',
        pid: stillRunning ? this.bedrockConsole.pid : null,
        startedAt: stillRunning ? previous.startedAt : null,
        playersOnline: stillRunning ? previous.playersOnline : 0,
        cpuPercent: stillRunning ? previous.cpuPercent : null,
        memoryBytes: stillRunning ? previous.memoryBytes : null,
        metricsUpdatedAt: stillRunning ? previous.metricsUpdatedAt : null,
        error: (error as Error).message || 'Échec de l’arrêt du serveur.',
      }).catch(() => undefined);
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.activeController?.abort(new Error('Arrêt du panel : déploiement annulé.'));
    const activeRun = this.activeRun;

    this.shutdownPromise = (async () => {
      // Stop an already-spawned child immediately so a pending start() can settle.
      // Abort is also passed to start/download/extraction; wait for that run before
      // performing a final stop to close the race where a child was being spawned.
      const firstStop = this.bedrockConsole.stop(Math.min(this.stopTimeoutMs, 5000));
      await Promise.allSettled([firstStop, activeRun ?? Promise.resolve()]);
      await this.bedrockConsole.stop(Math.min(this.stopTimeoutMs, 5000));
    })();
    return this.shutdownPromise;
  }

  private finishRun(runPromise: Promise<void>): void {
    if (this.activeRun !== runPromise) return;
    this.active = false;
    this.activeRun = null;
    this.activeController = null;
  }

  private async run(configuration: DeployConfiguration, signal: AbortSignal): Promise<void> {
    let reachedStopStage = false;
    let didModifyServer = false;
    let attemptedStart = false;
    let preserveExisting = false;
    let deploymentConfig = configuration;
    const wasRunningAtStart = this.bedrockConsole.isRunning;
    let unexpectedReadyExit: string | null = null;
    let temporaryArchive: string | null = null;
    let stagingDirectory: string | null = null;
    const trackUnexpectedExit = (event: { code: number | null; signal: NodeJS.Signals | null; wasReady: boolean; intentional?: boolean }) => {
      if (!event.intentional && event.wasReady) {
        const reason = event.signal ? `signal ${event.signal}` : `code ${event.code ?? 'inconnu'}`;
        unexpectedReadyExit = `bedrock_server s’est arrêté de façon inattendue (${reason}).`;
      }
    };
    this.bedrockConsole.on('exit', trackUnexpectedExit);

    try {
      throwIfAborted(signal);
      await this.setStep('preflight');
      const preflight = await this.inspector.inspect(true);
      throwIfAborted(signal);
      if (unexpectedReadyExit) throw new Error(`${unexpectedReadyExit} Déploiement interrompu avant la mise à jour.`);
      if (!preflight.deployReady) {
        const failures = [preflight.glibc, preflight.libcurl]
          .filter((check) => !check.ok)
          .map((check) => check.detail);
        if (preflight.platform !== 'linux' || preflight.arch !== 'x64') {
          failures.push(`Plateforme ${preflight.platform}/${preflight.arch} non prise en charge ; BDS Linux x64 est requis.`);
        }
        throw new Error(`Vérification système bloquante : ${failures.join(' ')}`);
      }

      assertSafeServerDirectory(this.serverDirectory, this.dataDirectory);
      await assertNoSymlinkInPath(path.dirname(this.serverDirectory));
      const currentDirectory = await lstat(this.serverDirectory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (currentDirectory?.isSymbolicLink() || (currentDirectory && !currentDirectory.isDirectory())) {
        throw new Error('BEDROCK_SERVER_DIR doit être un dossier réel ; aucune donnée n’a été touchée.');
      }
      preserveExisting = Boolean(currentDirectory?.isDirectory());
      const currentConfig = this.state.getSnapshot().activeConfig;
      if (preserveExisting && currentConfig) {
        // On updates only the game version changes. Keep the settings represented by
        // the existing files, as well as all player/world data.
        deploymentConfig = { ...currentConfig, version: configuration.version };
      }

      const version = this.findVersion(configuration.version);
      if (!version) throw new Error(`La version ${configuration.version} n’existe plus dans le catalogue.`);

      await this.setStep('downloading');
      throwIfAborted(signal);
      temporaryArchive = path.join(this.dataDirectory, `bedrock-${randomUUID()}.zip`);
      const download = await this.artifacts.download(
        version.downloadUrl,
        temporaryArchive,
        getMaxArchiveBytes(),
        signal,
      );
      throwIfAborted(signal);
      console.info(`[deploy] ZIP ${version.version} téléchargé (${download.bytes} octets).`);
      if (unexpectedReadyExit) throw new Error(`${unexpectedReadyExit} Le serveur s’est arrêté pendant le téléchargement.`);

      await this.setStep('extracting');
      throwIfAborted(signal);
      const serverParent = path.dirname(this.serverDirectory);
      await mkdir(serverParent, { recursive: true });
      await assertNoSymlinkInPath(serverParent);
      stagingDirectory = await mkdtemp(path.join(serverParent, '.ncraft-bedrock-stage-'));
      await this.artifacts.extract(temporaryArchive, stagingDirectory, signal);
      throwIfAborted(signal);
      const stagedBinaryPath = path.join(stagingDirectory, 'bedrock_server');
      const binaryStats = await lstat(stagedBinaryPath).catch(() => null);
      if (!binaryStats?.isFile() || binaryStats.isSymbolicLink()) {
        throw new Error('L’archive n’a pas fourni un fichier bedrock_server sûr à la racine.');
      }
      if (unexpectedReadyExit) throw new Error(`${unexpectedReadyExit} Le serveur s’est arrêté avant la mise à jour.`);

      // Keep the current version live during download/extraction. Stop gracefully
      // only when the staged release is valid and ready to be merged.
      await this.setStep('stopping');
      throwIfAborted(signal);
      reachedStopStage = true;
      if (this.bedrockConsole.isRunning) {
        await this.state.updateServer({ status: 'stopping', error: null });
        throwIfAborted(signal);
        await this.bedrockConsole.stop(this.stopTimeoutMs);
      }
      throwIfAborted(signal);
      await this.state.updateServer({
        status: 'stopped',
        pid: null,
        startedAt: null,
        error: null,
        playersOnline: 0,
        cpuPercent: null,
        memoryBytes: null,
        metricsUpdatedAt: null,
      });

      await this.setStep('updating_files');
      throwIfAborted(signal);
      didModifyServer = true;
      await mergeBedrockRelease(stagingDirectory, this.serverDirectory, { preserveExisting, signal });
      const binaryPath = path.join(this.serverDirectory, 'bedrock_server');
      await chmod(binaryPath, 0o755);

      await this.setStep('writing_config');
      throwIfAborted(signal);
      await writeBedrockConfiguration(this.serverDirectory, deploymentConfig, { preserveExisting });

      // The EULA response is performed only if the real binary emits a matching
      // interactive prompt. No undocumented eula.txt format is guessed here.
      await this.setStep('accepting_eula');
      await this.state.setEulaVerification('unverified');
      throwIfAborted(signal);
      await this.setStep('starting');
      throwIfAborted(signal);
      attemptedStart = true;
      await this.state.updateServer({
        status: 'starting',
        pid: null,
        startedAt: null,
        error: null,
        playersOnline: 0,
        cpuPercent: null,
        memoryBytes: null,
        metricsUpdatedAt: null,
      });
      throwIfAborted(signal);
      await this.bedrockConsole.start({
        binaryPath,
        workingDirectory: this.serverDirectory,
        timeoutMs: this.startTimeoutMs,
        signal,
        onEulaPrompt: () => {
          void this.state.setEulaVerification('prompt_accepted').catch((error) => {
            console.error(`[deploy] Could not persist EULA prompt result: ${(error as Error).message}`);
          });
        },
      });

      throwIfAborted(signal);
      if (!this.bedrockConsole.isReady) throw new Error('bedrock_server a quitté après le signal de disponibilité.');
      if (this.state.getSnapshot().verification.eula === 'unverified') {
        await this.state.setEulaVerification('no_prompt_observed');
      }
      await this.state.setActiveConfig(deploymentConfig);
      throwIfAborted(signal);
      if (!this.bedrockConsole.isReady) throw new Error('bedrock_server s’est arrêté avant la validation finale du déploiement.');
      await this.state.updateServer({
        status: 'running',
        pid: this.bedrockConsole.pid,
        startedAt: new Date().toISOString(),
        playersOnline: this.bedrockConsole.onlinePlayersCount,
        error: null,
      });
      if (!this.bedrockConsole.isReady) throw new Error('bedrock_server s’est arrêté pendant la finalisation du déploiement.');
      await this.state.updatePipeline({ status: 'idle', step: 'running', error: null });
      if (!this.bedrockConsole.isReady) throw new Error('bedrock_server s’est arrêté juste après la finalisation du déploiement.');
    } catch (error) {
      let message = signal.aborted
        ? 'Déploiement annulé pendant l’arrêt du panel.'
        : (error as Error).message || 'Erreur inconnue pendant le déploiement.';
      console.error(`[deploy] ${message}`);

      if (attemptedStart && this.bedrockConsole.isRunning) {
        try {
          await this.bedrockConsole.stop(this.stopTimeoutMs);
        } catch (stopError) {
          message = `${message} Échec de l’arrêt de bedrock_server : ${(stopError as Error).message}`;
        }
      }

      const failedStep = this.state.getSnapshot().pipeline.step;
      await this.state.updatePipeline({ status: 'failed', step: failedStep === 'failed' ? 'preflight' : failedStep, error: message }).catch(() => undefined);
      if (!reachedStopStage && wasRunningAtStart && this.bedrockConsole.isRunning) {
        // A failed preflight/download must not stop or misreport the old server.
        await this.state.updateServer({ status: 'running', pid: this.bedrockConsole.pid }).catch(() => undefined);
      } else if (this.bedrockConsole.isRunning) {
        await this.state.updateServer({ status: 'failed', pid: this.bedrockConsole.pid, error: message }).catch(() => undefined);
      } else {
        await this.state.updateServer({
          status: attemptedStart || didModifyServer || Boolean(unexpectedReadyExit) ? 'failed' : 'stopped',
          pid: null,
          startedAt: null,
          playersOnline: 0,
          cpuPercent: null,
          memoryBytes: null,
          metricsUpdatedAt: null,
          error: message,
        }).catch(() => undefined);
      }
    } finally {
      this.bedrockConsole.removeListener('exit', trackUnexpectedExit);
      if (temporaryArchive) await rm(temporaryArchive, { force: true }).catch(() => undefined);
      if (stagingDirectory) await rm(stagingDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch((error) => {
        console.error(`[deploy] Could not remove temporary staging folder: ${(error as Error).message}`);
      });
    }
  }

  private async runExistingRestart(signal: AbortSignal): Promise<void> {
    try {
      throwIfAborted(signal);
      await this.setStep('stopping');
      await this.state.updateServer({ status: 'stopping', error: null });
      await this.bedrockConsole.stop(this.stopTimeoutMs);
      await this.state.updateServer({
        status: 'stopped',
        pid: null,
        startedAt: null,
        error: null,
        playersOnline: 0,
        cpuPercent: null,
        memoryBytes: null,
        metricsUpdatedAt: null,
      });
      throwIfAborted(signal);
      await this.runExistingStart(signal);
    } catch (error) {
      const message = (error as Error).message || 'Échec du redémarrage planifié de Bedrock.';
      const failedStep = this.state.getSnapshot().pipeline.step;
      await this.state.updatePipeline({ status: 'failed', step: failedStep === 'failed' ? 'stopping' : failedStep, error: message }).catch(() => undefined);
      if (!this.bedrockConsole.isRunning) {
        await this.state.updateServer({
          status: 'failed',
          pid: null,
          startedAt: null,
          playersOnline: 0,
          cpuPercent: null,
          memoryBytes: null,
          metricsUpdatedAt: null,
          error: message,
        }).catch(() => undefined);
      }
      throw error;
    }
  }

  private async runExistingStart(signal: AbortSignal): Promise<void> {
    let attemptedStart = false;
    const currentConfig = this.state.getSnapshot().activeConfig;
    try {
      if (!currentConfig) throw new ServerNotInstalledError();
      if (this.bedrockConsole.isRunning) throw new Error('bedrock_server est déjà en cours d’exécution.');

      throwIfAborted(signal);
      await this.setStep('preflight');
      const preflight = await this.inspector.inspect(true);
      throwIfAborted(signal);
      if (!preflight.deployReady) {
        const failures = [preflight.glibc, preflight.libcurl]
          .filter((check) => !check.ok)
          .map((check) => check.detail);
        if (preflight.platform !== 'linux' || preflight.arch !== 'x64') {
          failures.push(`Plateforme ${preflight.platform}/${preflight.arch} non prise en charge ; BDS Linux x64 est requis.`);
        }
        throw new Error(`Vérification système bloquante : ${failures.join(' ')}`);
      }
      if (!preflight.bedrockBinary.ok) throw new ServerNotInstalledError();

      const directoryInfo = await lstat(this.serverDirectory);
      const binaryPath = path.join(this.serverDirectory, 'bedrock_server');
      const binaryInfo = await lstat(binaryPath);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
        throw new Error('Le dossier du serveur est absent ou est un lien symbolique ; démarrage refusé.');
      }
      if (!binaryInfo.isFile() || binaryInfo.isSymbolicLink() || (binaryInfo.mode & 0o111) === 0) {
        throw new ServerNotInstalledError();
      }

      throwIfAborted(signal);
      await this.setStep('starting');
      attemptedStart = true;
      await this.state.updateServer({
        status: 'starting', pid: null, startedAt: null, error: null,
        playersOnline: 0, cpuPercent: null, memoryBytes: null, metricsUpdatedAt: null,
      });
      await this.bedrockConsole.start({
        binaryPath,
        workingDirectory: this.serverDirectory,
        timeoutMs: this.startTimeoutMs,
        signal,
        onEulaPrompt: () => {
          void this.state.setEulaVerification('prompt_accepted').catch((error) => {
            console.error(`[start] Could not persist EULA prompt result: ${(error as Error).message}`);
          });
        },
      });

      throwIfAborted(signal);
      if (!this.bedrockConsole.isReady) throw new Error('bedrock_server a quitté avant de confirmer son démarrage.');
      if (this.state.getSnapshot().verification.eula === 'unverified') {
        await this.state.setEulaVerification('no_prompt_observed');
      }
      await this.state.updateServer({
        status: 'running',
        pid: this.bedrockConsole.pid,
        startedAt: new Date().toISOString(),
        playersOnline: this.bedrockConsole.onlinePlayersCount,
        error: null,
      });
      await this.state.updatePipeline({ status: 'idle', step: 'running', error: null });
    } catch (error) {
      const message = (error as Error).message || 'Erreur inconnue pendant le démarrage de Bedrock.';
      if (signal.aborted && this.bedrockConsole.isRunning) {
        await this.bedrockConsole.stop(this.stopTimeoutMs).catch((stopError) => {
          console.error(`[start] Bedrock shutdown after cancellation failed: ${(stopError as Error).message}`);
        });
      }
      await this.state.updatePipeline({
        status: 'failed',
        step: signal.aborted ? 'failed' : (attemptedStart ? 'starting' : 'preflight'),
        error: message,
      }).catch(() => undefined);
      const stillRunning = this.bedrockConsole.isRunning;
      await this.state.updateServer({
        status: stillRunning ? 'failed' : (attemptedStart ? 'failed' : 'stopped'),
        pid: stillRunning ? this.bedrockConsole.pid : null,
        startedAt: stillRunning ? this.state.getSnapshot().server.startedAt : null,
        playersOnline: stillRunning ? this.bedrockConsole.onlinePlayersCount : 0,
        cpuPercent: stillRunning ? this.state.getSnapshot().server.cpuPercent : null,
        memoryBytes: stillRunning ? this.state.getSnapshot().server.memoryBytes : null,
        metricsUpdatedAt: stillRunning ? this.state.getSnapshot().server.metricsUpdatedAt : null,
        error: message,
      }).catch(() => undefined);
      console.error(`[start] ${message}`);
    }
  }

  private async setStep(step: PipelineStep): Promise<void> {
    await this.state.updatePipeline({ status: 'running', step, error: null });
  }

  private readTimeout(variable: string, fallback: number): number {
    const candidate = Number(process.env[variable]);
    return Number.isSafeInteger(candidate) && candidate >= 1000 ? candidate : fallback;
  }
}
