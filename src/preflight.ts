import { spawnSync } from 'node:child_process';
import { access, readFile, stat, statfs } from 'node:fs/promises';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import type { SystemCheck, SystemPreflight, TunnelProvider } from './types/backend.ts';
import { resolveTunnelProvider } from './tunnelProvider.ts';
import { DISK_HEADROOM_BYTES, getMaxArchiveBytes, MAX_UNPACKED_BYTES } from './bedrock/limits.ts';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const BEDROCK_MEMORY_REQUIREMENT = 4 * GIB;
const GLIBC_MINIMUM = [2, 29] as const;

export function resolveExecutable(command: string): string | null {
  const candidate = command.trim();
  if (!candidate) return null;
  const hasPath = candidate.includes(path.sep);
  const possiblePaths = hasPath
    ? [path.resolve(candidate)]
    : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, candidate));

  for (const executable of possiblePaths) {
    try {
      accessSync(executable, constants.X_OK);
      return executable;
    } catch {
      // Try the next PATH entry.
    }
  }
  return null;
}

function parseVersion(text: string): string | null {
  const match = text.match(/(?:ldd\s+\([^)]*\)\s+)?(\d+)\.(\d+)(?:\.(\d+))?/i);
  return match ? `${match[1]}.${match[2]}${match[3] ? `.${match[3]}` : ''}` : null;
}

function versionAtLeast(version: string | null, minimum: readonly [number, number]): boolean {
  if (!version) return false;
  const [major = 0, minor = 0] = version.split('.').map((part) => Number(part));
  return major > minimum[0] || (major === minimum[0] && minor >= minimum[1]);
}

async function readMemoryLimit(): Promise<number | null> {
  const candidates = [
    '/sys/fs/cgroup/memory.max',
    '/sys/fs/cgroup/memory/memory.limit_in_bytes',
  ];
  for (const file of candidates) {
    try {
      const raw = (await readFile(file, 'utf8')).trim();
      if (!raw || raw === 'max') continue;
      const value = Number(raw);
      // cgroup v1 may report an effectively-unlimited sentinel close to 2^63.
      if (Number.isFinite(value) && value > 0 && value < 2 ** 60) return value;
    } catch {
      // Try the other cgroup layout.
    }
  }
  return null;
}

async function libcurlCheck(): Promise<SystemCheck> {
  const ldconfig = spawnSync('ldconfig', ['-p'], { encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024 });
  if (ldconfig.status === 0 && /libcurl\.so\.4\s/.test(ldconfig.stdout)) {
    return { ok: true, detail: 'libcurl.so.4 est référencée par ldconfig.' };
  }

  const libraryPaths = [
    ...(process.env.LD_LIBRARY_PATH ?? '').split(path.delimiter).filter(Boolean),
    '/lib/x86_64-linux-gnu',
    '/usr/lib/x86_64-linux-gnu',
    '/lib/aarch64-linux-gnu',
    '/usr/lib/aarch64-linux-gnu',
    '/usr/local/lib',
  ];
  for (const directory of libraryPaths) {
    try {
      await access(path.join(directory, 'libcurl.so.4'), constants.R_OK);
      return { ok: true, detail: `libcurl.so.4 trouvée dans ${directory}.` };
    } catch {
      // Continue through known linker directories.
    }
  }
  return {
    ok: false,
    detail: 'libcurl.so.4 introuvable via ldconfig et les chemins standards ; BDS risque de refuser de démarrer.',
  };
}

async function getDiskFreeBytes(directory: string): Promise<number | null> {
  let candidate = path.resolve(directory);
  while (true) {
    try {
      const stats = await statfs(candidate, { bigint: true });
      return Number(stats.bavail * stats.bsize);
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) return null;
      candidate = parent;
    }
  }
}

async function filesystemDevice(directory: string): Promise<bigint | null> {
  let candidate = path.resolve(directory);
  while (true) {
    try {
      return (await stat(candidate, { bigint: true })).dev;
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) return null;
      candidate = parent;
    }
  }
}

export class SystemInspector {
  private lastSnapshot: SystemPreflight | null = null;
  private lastCheckedAt = 0;

  constructor(
    private readonly dataDirectory: string,
    private readonly serverDirectory: string,
    private readonly playitCommand: string,
    private readonly playitCliCommand = process.env.PLAYIT_CLI_BIN?.trim() || 'playit',
    private readonly localtonetCommand = process.env.LOCALTONET_BIN?.trim() || 'localtonet',
    private readonly tunnelProvider: TunnelProvider = resolveTunnelProvider(),
  ) {}

  async inspect(force = false): Promise<SystemPreflight> {
    if (!force && this.lastSnapshot && Date.now() - this.lastCheckedAt < 10_000) {
      return structuredClone(this.lastSnapshot);
    }

    const ldd = spawnSync('ldd', ['--version'], { encoding: 'utf8', timeout: 3000, maxBuffer: 128 * 1024 });
    const lddOutput = `${ldd.stdout ?? ''}\n${ldd.stderr ?? ''}`;
    const runtimeReport = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined;
    const reportGlibc = runtimeReport?.header?.glibcVersionRuntime;
    const glibcVersion = parseVersion(lddOutput) ?? (reportGlibc ? parseVersion(reportGlibc) : null);
    const glibcOk = process.platform === 'linux' && versionAtLeast(glibcVersion, GLIBC_MINIMUM);
    const glibc: SystemCheck = {
      ok: glibcOk,
      detail: glibcVersion
        ? `glibc ${glibcVersion}${glibcOk ? '' : ' est inférieure au minimum visé 2.29.'}`
        : 'Version glibc non détectée (ldd --version indisponible).',
    };
    const libcurl = process.platform === 'linux'
      ? await libcurlCheck()
      : { ok: false, detail: 'BDS Linux exige un conteneur Linux.' };

    const playitPath = resolveExecutable(this.playitCommand);
    const playitBinary: SystemCheck = playitPath
      ? { ok: true, detail: `Daemon Playit détecté : ${playitPath}` }
      : { ok: false, detail: `Daemon Playit "${this.playitCommand}" absent du PATH.` };
    const playitCliPath = resolveExecutable(this.playitCliCommand);
    const playitCliBinary: SystemCheck = playitCliPath
      ? { ok: true, detail: `CLI Playit détecté : ${playitCliPath}` }
      : { ok: false, detail: `CLI Playit "${this.playitCliCommand}" absent du PATH ; le lien de claim ne peut pas être généré.` };
    const localtonetPath = resolveExecutable(this.localtonetCommand);
    const localtonetBinary: SystemCheck = localtonetPath
      ? { ok: true, detail: `Client Localtonet détecté : ${localtonetPath}` }
      : { ok: false, detail: `Client Localtonet "${this.localtonetCommand}" absent du PATH.` };

    let bedrockExists = false;
    try {
      await access(path.join(this.serverDirectory, 'bedrock_server'), constants.X_OK);
      bedrockExists = true;
    } catch {
      // It is expected to be absent before the first deployment.
    }
    const bedrockBinary: SystemCheck = bedrockExists
      ? { ok: true, detail: 'bedrock_server exécutable présent.' }
      : { ok: false, detail: 'bedrock_server absent (normal avant le premier déploiement).' };

    const memoryLimitBytes = await readMemoryLimit();
    const memoryWarning = memoryLimitBytes === null || memoryLimitBytes < BEDROCK_MEMORY_REQUIREMENT;
    const dataDiskFreeBytes = await getDiskFreeBytes(this.dataDirectory);
    const serverDiskDirectory = path.dirname(this.serverDirectory);
    const serverDiskFreeBytes = await getDiskFreeBytes(serverDiskDirectory);
    const [dataDevice, serverDevice] = await Promise.all([
      filesystemDevice(this.dataDirectory),
      filesystemDevice(serverDiskDirectory),
    ]);
    const sharedDiskVolume = dataDevice !== null && serverDevice !== null
      ? dataDevice === serverDevice
      : null;

    const archiveRequired = getMaxArchiveBytes();
    const serverRequired = MAX_UNPACKED_BYTES + DISK_HEADROOM_BYTES;
    const combinedRequired = archiveRequired + MAX_UNPACKED_BYTES + DISK_HEADROOM_BYTES;
    const dataDiskRequiredBytes = sharedDiskVolume === false
      ? archiveRequired + DISK_HEADROOM_BYTES
      : combinedRequired;
    const serverDiskRequiredBytes = sharedDiskVolume === true ? 0 : serverRequired;
    const diskFreeBytes = dataDiskFreeBytes === null || serverDiskFreeBytes === null
      ? null
      : Math.min(dataDiskFreeBytes, serverDiskFreeBytes);
    const diskWarning =
      dataDiskFreeBytes === null ||
      serverDiskFreeBytes === null ||
      dataDiskFreeBytes < dataDiskRequiredBytes ||
      (serverDiskRequiredBytes > 0 && serverDiskFreeBytes < serverDiskRequiredBytes);
    const warnings: string[] = [];

    if (memoryLimitBytes === null) {
      warnings.push('Limite mémoire du conteneur non détectée ; vérifie qu’au moins 4 Go sont disponibles pour BDS.');
    } else if (memoryWarning) {
      warnings.push(`Mémoire limitée à ${(memoryLimitBytes / GIB).toFixed(1)} Go ; la page officielle BDS indique 4 Go. L’essai est autorisé, mais un OOM est possible.`);
    }
    if (this.tunnelProvider === 'localtonet') {
      if (!localtonetPath) warnings.push('Le tunnel Localtonet ne démarrera pas tant que le client localtonet ne sera pas présent dans le PATH.');
      if (!process.env.LOCALTONET_AUTH_TOKEN?.trim()) warnings.push('LOCALTONET_AUTH_TOKEN absent : le client Localtonet ne peut pas s’authentifier.');
      if (!process.env.LOCALTONET_API_KEY?.trim()) warnings.push('LOCALTONET_API_KEY absente : le dashboard ne peut pas détecter l’adresse publique Localtonet.');
    } else {
      if (!playitPath) warnings.push('Le tunnel Playit ne démarrera pas tant que le daemon playitd ne sera pas présent dans le PATH.');
      if (!playitCliPath) warnings.push('Le lien de claim Playit ne pourra pas être généré tant que le CLI officiel playit ne sera pas présent dans le PATH.');
    }
    if (dataDiskFreeBytes === null) {
      warnings.push('Espace libre du volume DATA_DIR non détecté.');
    } else if (dataDiskFreeBytes < dataDiskRequiredBytes) {
      warnings.push(`Volume DATA_DIR : ${(dataDiskFreeBytes / GIB).toFixed(1)} Go libres ; environ ${(dataDiskRequiredBytes / GIB).toFixed(1)} Go peuvent être nécessaires pour l’archive et l’extraction.`);
    }
    if (serverDiskFreeBytes === null) {
      warnings.push('Espace libre du volume BEDROCK_SERVER_DIR non détecté.');
    } else if (serverDiskRequiredBytes > 0 && serverDiskFreeBytes < serverDiskRequiredBytes) {
      warnings.push(`Volume BEDROCK_SERVER_DIR : ${(serverDiskFreeBytes / GIB).toFixed(1)} Go libres ; jusqu’à ${(serverDiskRequiredBytes / GIB).toFixed(1)} Go sont prévus pour l’extraction et la marge.`);
    }
    if (sharedDiskVolume === null) {
      warnings.push('Impossible de déterminer si DATA_DIR et BEDROCK_SERVER_DIR partagent le même volume ; estimation disque conservatrice affichée.');
    }
    if (!libcurl.ok) warnings.push(libcurl.detail);
    if (!glibc.ok) warnings.push(glibc.detail);

    const snapshot: SystemPreflight = {
      checkedAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      glibcVersion,
      glibc,
      libcurl,
      memoryLimitBytes,
      memoryRequirementBytes: BEDROCK_MEMORY_REQUIREMENT,
      memoryWarning,
      diskFreeBytes,
      dataDiskFreeBytes,
      serverDiskFreeBytes,
      dataDiskRequiredBytes,
      serverDiskRequiredBytes,
      sharedDiskVolume,
      diskWarning,
      localtonetBinary,
      playitBinary,
      playitCliBinary,
      bedrockBinary,
      deployReady: process.platform === 'linux' && process.arch === 'x64' && glibc.ok && libcurl.ok,
      warnings,
    };

    this.lastSnapshot = snapshot;
    this.lastCheckedAt = Date.now();
    return structuredClone(snapshot);
  }
}
