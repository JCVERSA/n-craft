import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readCleartextMessage, readKeys, verify } from 'openpgp';
import { chmod, lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzip as gunzipCallback } from 'node:zlib';

const execFileAsync = promisify(execFile);
const gunzip = promisify(gunzipCallback);

const UBUNTU_ARCHIVE_HOST = 'archive.ubuntu.com';
const UBUNTU_BASE_URL = `https://${UBUNTU_ARCHIVE_HOST}/ubuntu`;
const UBUNTU_RELEASE = 'focal-updates';
const UBUNTU_ARCHIVE_KEY_URL = `${UBUNTU_BASE_URL}/project/ubuntu-archive-keyring.gpg`;
const UBUNTU_INRELEASE_URL = `${UBUNTU_BASE_URL}/dists/${UBUNTU_RELEASE}/InRelease`;
const UBUNTU_PACKAGES_RELATIVE_PATH = 'main/binary-amd64/Packages.gz';
const UBUNTU_PACKAGES_URL = `${UBUNTU_BASE_URL}/dists/${UBUNTU_RELEASE}/${UBUNTU_PACKAGES_RELATIVE_PATH}`;
const TRUSTED_UBUNTU_ARCHIVE_FINGERPRINTS = new Set([
  // Ubuntu Archive Automatic Signing Key (2018), pinned from Ubuntu's published fingerprint.
  'F6ECB3762474EDA9D21B7022871920D1991BC93C',
]);
const MAX_KEYRING_BYTES = 2 * 1024 * 1024;
const MAX_INRELEASE_BYTES = 16 * 1024 * 1024;
const MAX_PACKAGES_GZIP_BYTES = 12 * 1024 * 1024;
const MAX_PACKAGES_INDEX_BYTES = 96 * 1024 * 1024;
const MAX_DEB_BYTES = 8 * 1024 * 1024;
const LEGACY_SSL_NAMES = new Set(['libssl.so.1.1', 'libcrypto.so.1.1']);

export interface BinaryDependencyReport {
  isElf: boolean;
  missingLibraries: string[];
  compatibilityIssues: string[];
  output: string;
}

export type BinaryDependencyInspector = (
  binaryPath: string,
  librarySearchPath: string,
  signal?: AbortSignal,
) => Promise<BinaryDependencyReport>;

export type LegacyOpenSslInstaller = (dataDirectory: string, signal?: AbortSignal) => Promise<void>;

export interface BedrockRuntimeSupport {
  ensureForBinary(binaryPath: string, workingDirectory: string, signal?: AbortSignal): Promise<void>;
  libraryDirectories(): string[];
}

interface UbuntuPackageRecord {
  filename: string;
  sha256: string;
  size: number;
  version: string;
}

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBufferBytes?: number;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error('Vérification des dépendances Bedrock annulée.');
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function subprocessEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/(?:TOKEN|SECRET|API_KEY|PASSWORD|AUTH)/i.test(key)) continue;
    environment[key] = value;
  }
  return { ...environment, ...extra };
}

async function runCommand(
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  throwIfAborted(options.signal);
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env ?? subprocessEnvironment(),
      signal: options.signal,
      timeout: options.timeoutMs ?? 15_000,
      maxBuffer: options.maxBufferBytes ?? 1024 * 1024,
      encoding: 'utf8',
      windowsHide: true,
    });
    return { exitCode: 0, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
  } catch (error) {
    throwIfAborted(options.signal);
    const commandError = error as NodeJS.ErrnoException & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      signal?: NodeJS.Signals;
      killed?: boolean;
    };
    if (commandError.code === 'ENOENT') throw new Error(`Commande système absente : ${command}.`);
    return {
      exitCode: typeof commandError.code === 'number' ? commandError.code : null,
      stdout: String(commandError.stdout ?? ''),
      stderr: String(commandError.stderr ?? ''),
    };
  }
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(60_000);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function assertUbuntuArchiveUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== UBUNTU_ARCHIVE_HOST ||
    !url.pathname.startsWith('/ubuntu/') ||
    url.username ||
    url.password
  ) {
    throw new Error('URL refusée : les dépendances de compatibilité doivent venir de l’archive HTTPS officielle Ubuntu.');
  }
  return url;
}

async function fetchUbuntuBytes(urlInput: string, maximumBytes: number, signal?: AbortSignal): Promise<Buffer> {
  const url = assertUbuntuArchiveUrl(urlInput);
  throwIfAborted(signal);
  const response = await fetch(url, {
    redirect: 'error',
    signal: requestSignal(signal),
    headers: { 'user-agent': 'N-Craft-Bedrock-Runtime/1.0' },
  });
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Téléchargement Ubuntu refusé : HTTP ${response.status}.`);
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body.cancel().catch(() => undefined);
    throw new Error(`Fichier Ubuntu trop volumineux (${declaredLength} octets).`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > maximumBytes) {
    throw new Error(`Fichier Ubuntu vide ou supérieur à la limite de ${maximumBytes} octets.`);
  }
  if (Number.isFinite(declaredLength) && declaredLength > 0 && bytes.length !== declaredLength) {
    throw new Error(`Téléchargement Ubuntu incomplet : ${bytes.length} octets reçus sur ${declaredLength}.`);
  }
  return bytes;
}

export function parseUbuntuReleaseSha256(payload: string): Map<string, { sha256: string; size: number }> {
  const sectionMatch = payload.match(/(?:^|\n)SHA256:\s*\n([\s\S]*?)(?=\n[A-Za-z][A-Za-z0-9-]*:\s*|\s*$)/);
  if (!sectionMatch?.[1]) throw new Error('Métadonnées Ubuntu invalides : section SHA256 absente.');
  const records = new Map<string, { sha256: string; size: number }>();
  for (const line of sectionMatch[1].split('\n')) {
    const match = line.trim().match(/^([a-f\d]{64})\s+(\d+)\s+(\S+)$/i);
    if (!match) continue;
    const size = Number(match[2]);
    const relativePath = match[3]!.replace(/^\.\//, '');
    if (!Number.isSafeInteger(size) || size < 0 || relativePath.startsWith('/') || relativePath.split('/').includes('..')) {
      throw new Error('Métadonnées Ubuntu invalides : chemin ou taille de fichier refusé.');
    }
    records.set(relativePath, { sha256: match[1]!.toLowerCase(), size });
  }
  return records;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseDebianControl(stanza: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of stanza.split('\n')) {
    if (!line || /^\s/.test(line)) continue;
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    fields.set(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  return fields;
}

export function parseUbuntuFocalLibsslRecord(packagesIndex: string): UbuntuPackageRecord {
  for (const stanza of packagesIndex.split(/\n\s*\n/)) {
    const fields = parseDebianControl(stanza);
    const version = fields.get('Version') ?? '';
    const filename = fields.get('Filename') ?? '';
    const digest = fields.get('SHA256') ?? '';
    const size = Number(fields.get('Size'));
    if (
      fields.get('Package') !== 'libssl1.1' ||
      fields.get('Architecture') !== 'amd64' ||
      !/^1\.1\.1f-1ubuntu2(?:\.\d+)?$/.test(version)
    ) continue;

    if (!/^pool\/main\/o\/openssl\/libssl1\.1_1\.1\.1f-1ubuntu2(?:\.\d+)?_amd64\.deb$/.test(filename)) {
      throw new Error('Métadonnées Ubuntu invalides : chemin du paquet libssl1.1 refusé.');
    }
    if (!/^[a-f\d]{64}$/i.test(digest) || !Number.isSafeInteger(size) || size <= 0 || size > MAX_DEB_BYTES) {
      throw new Error('Métadonnées Ubuntu invalides : taille ou SHA-256 du paquet libssl1.1 refusé.');
    }
    return { filename, sha256: digest.toLowerCase(), size, version };
  }
  throw new Error('Aucun paquet libssl1.1 amd64 pris en charge n’a été trouvé dans l’index Ubuntu focal-updates signé.');
}

function parseReleaseValue(payload: string, field: string): string | null {
  const match = payload.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  return match?.[1]?.trim() ?? null;
}

async function assertNoSymlinkInPath(directory: string): Promise<void> {
  let current = path.resolve(directory);
  while (true) {
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info?.isSymbolicLink()) throw new Error(`Installation OpenSSL refusée : le chemin ${current} contient un lien symbolique.`);
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function assertRealLibrary(libraryPath: string): Promise<void> {
  const info = await lstat(libraryPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info?.isFile() || info.isSymbolicLink() || info.size < 16 * 1024) {
    throw new Error(`Paquet libssl1.1 refusé : bibliothèque absente, vide ou non régulière (${path.basename(libraryPath)}).`);
  }
}

export function getOpenSsl11LibraryDirectory(dataDirectory: string): string {
  return path.join(dataDirectory, 'runtime', 'ubuntu-focal-libssl1.1', 'usr', 'lib', 'x86_64-linux-gnu');
}

async function hasBundledOpenSsl11(dataDirectory: string): Promise<boolean> {
  const directory = getOpenSsl11LibraryDirectory(dataDirectory);
  try {
    await assertNoSymlinkInPath(directory);
    await Promise.all([
      assertRealLibrary(path.join(directory, 'libssl.so.1.1')),
      assertRealLibrary(path.join(directory, 'libcrypto.so.1.1')),
    ]);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    if ((error as Error).message.includes('absente, vide ou non régulière')) return false;
    if ((error as Error).message.includes('contient un lien symbolique')) return false;
    throw error;
  }
}

export async function verifyUbuntuInRelease(
  inRelease: Buffer,
  keyring: Buffer,
  options: {
    trustedFingerprints?: ReadonlySet<string>;
    signal?: AbortSignal;
  } = {},
): Promise<string> {
  const trustedFingerprints = options.trustedFingerprints ?? TRUSTED_UBUNTU_ARCHIVE_FINGERPRINTS;
  throwIfAborted(options.signal);

  const archiveKeys = await readKeys({ binaryKeys: keyring });
  const trustedKeys = archiveKeys.filter((key) =>
    trustedFingerprints.has(key.getFingerprint().toUpperCase()),
  );
  if (trustedKeys.length === 0) {
    throw new Error('Signature Ubuntu refusée : l’empreinte ne correspond pas à la clé d’archive Ubuntu épinglée.');
  }

  const trustedKeyIds = new Set<string>();
  for (const key of trustedKeys) {
    trustedKeyIds.add(key.getKeyID().toHex().toUpperCase());
    for (const subkey of key.getSubkeys()) trustedKeyIds.add(subkey.getKeyID().toHex().toUpperCase());
  }

  let message;
  try {
    message = await readCleartextMessage({ cleartextMessage: inRelease.toString('utf8') });
  } catch {
    throw new Error('Métadonnées Ubuntu invalides : enveloppe InRelease ou signature absente.');
  }
  if (!message.getSigningKeyIDs().some((keyId) => trustedKeyIds.has(keyId.toHex().toUpperCase()))) {
    throw new Error('Signature Ubuntu refusée : le fichier n’a pas été signé par la clé d’archive épinglée.');
  }

  let verification;
  try {
    verification = await verify({
      message,
      verificationKeys: trustedKeys,
      expectSigned: true,
    });
  } catch {
    throw new Error('Signature InRelease Ubuntu invalide : le contenu ne correspond pas à la signature.');
  }
  const trustedSignatures = verification.signatures.filter((signature) =>
    trustedKeyIds.has(signature.keyID.toHex().toUpperCase()),
  );
  if (trustedSignatures.length === 0) {
    throw new Error('Signature Ubuntu refusée : aucune signature vérifiable de la clé d’archive épinglée.');
  }
  try {
    await Promise.all(trustedSignatures.map((signature) => signature.verified));
  } catch {
    throw new Error('Signature InRelease Ubuntu invalide : le contenu ne correspond pas à la signature.');
  }
  throwIfAborted(options.signal);

  const payload = message.getText();
  if (
    parseReleaseValue(payload, 'Origin') !== 'Ubuntu' ||
    parseReleaseValue(payload, 'Label') !== 'Ubuntu' ||
    parseReleaseValue(payload, 'Suite') !== UBUNTU_RELEASE ||
    parseReleaseValue(payload, 'Codename') !== 'focal'
  ) {
    throw new Error('Dépôt refusé : les métadonnées signées ne correspondent pas à Ubuntu focal-updates.');
  }
  const architectures = parseReleaseValue(payload, 'Architectures')?.split(/\s+/) ?? [];
  const components = parseReleaseValue(payload, 'Components')?.split(/\s+/) ?? [];
  if (!architectures.includes('amd64') || !components.includes('main')) {
    throw new Error('Dépôt refusé : Ubuntu focal-updates ne publie pas l’architecture/composant requis.');
  }
  const releaseDate = parseReleaseValue(payload, 'Date');
  const releaseTime = releaseDate ? Date.parse(releaseDate) : Number.NaN;
  if (!Number.isFinite(releaseTime) || releaseTime > Date.now() + 24 * 60 * 60 * 1000 || Date.now() - releaseTime > 45 * 24 * 60 * 60 * 1000) {
    throw new Error('Dépôt refusé : les métadonnées signées Ubuntu sont absentes, trop anciennes ou datées dans le futur.');
  }
  return payload;
}

async function installUbuntuFocalOpenSsl11(dataDirectory: string, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const finalRoot = path.join(dataDirectory, 'runtime', 'ubuntu-focal-libssl1.1');
  const runtimeParent = path.dirname(finalRoot);
  await assertNoSymlinkInPath(runtimeParent);
  await mkdir(runtimeParent, { recursive: true, mode: 0o700 });

  const existingRoot = await lstat(finalRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existingRoot?.isSymbolicLink() || (existingRoot && !existingRoot.isDirectory())) {
    throw new Error(`Installation OpenSSL refusée : ${finalRoot} n’est pas un dossier réel.`);
  }
  if (existingRoot) {
    if (await hasBundledOpenSsl11(dataDirectory)) return;
    throw new Error(`Installation OpenSSL refusée : le dossier existant ${finalRoot} est incomplet et ne sera pas écrasé.`);
  }

  const downloadsDirectory = await mkdtemp(path.join(tmpdir(), 'ncraft-openssl11-download-'));
  const stagingDirectory = await mkdtemp(path.join(runtimeParent, '.ncraft-openssl11-stage-'));
  let installed = false;
  try {
    const [keyring, inRelease] = await Promise.all([
      fetchUbuntuBytes(UBUNTU_ARCHIVE_KEY_URL, MAX_KEYRING_BYTES, signal),
      fetchUbuntuBytes(UBUNTU_INRELEASE_URL, MAX_INRELEASE_BYTES, signal),
    ]);
    const payload = await verifyUbuntuInRelease(inRelease, keyring, { signal });
    const signedFiles = parseUbuntuReleaseSha256(payload);
    const packagesHash = signedFiles.get(UBUNTU_PACKAGES_RELATIVE_PATH);
    if (!packagesHash || packagesHash.size > MAX_PACKAGES_GZIP_BYTES) {
      throw new Error('Index Ubuntu refusé : Packages.gz amd64 absent ou trop volumineux.');
    }

    const compressedPackages = await fetchUbuntuBytes(UBUNTU_PACKAGES_URL, MAX_PACKAGES_GZIP_BYTES, signal);
    if (compressedPackages.length !== packagesHash.size || sha256(compressedPackages) !== packagesHash.sha256) {
      throw new Error('Index Ubuntu refusé : la taille ou le SHA-256 de Packages.gz ne correspond pas à InRelease.');
    }
    const expandedPackages = await gunzip(compressedPackages, { maxOutputLength: MAX_PACKAGES_INDEX_BYTES });
    const packagesRecord = parseUbuntuFocalLibsslRecord(expandedPackages.toString('utf8'));
    if (packagesRecord.size > MAX_DEB_BYTES) throw new Error('Paquet libssl1.1 refusé : taille supérieure à la limite.');

    const packageUrl = `${UBUNTU_BASE_URL}/${packagesRecord.filename}`;
    const packageBytes = await fetchUbuntuBytes(packageUrl, MAX_DEB_BYTES, signal);
    if (packageBytes.length !== packagesRecord.size || sha256(packageBytes) !== packagesRecord.sha256) {
      throw new Error('Paquet libssl1.1 refusé : la taille ou le SHA-256 ne correspond pas à l’index Ubuntu signé.');
    }
    const packagePath = path.join(downloadsDirectory, 'libssl1.1.deb');
    await writeFile(packagePath, packageBytes, { flag: 'wx', mode: 0o600 });

    const packageName = await runCommand('dpkg-deb', ['--field', packagePath, 'Package'], { signal });
    const packageVersion = await runCommand('dpkg-deb', ['--field', packagePath, 'Version'], { signal });
    const packageArchitecture = await runCommand('dpkg-deb', ['--field', packagePath, 'Architecture'], { signal });
    if (
      packageName.exitCode !== 0 || packageVersion.exitCode !== 0 || packageArchitecture.exitCode !== 0 ||
      packageName.stdout.trim() !== 'libssl1.1' ||
      packageVersion.stdout.trim() !== packagesRecord.version ||
      packageArchitecture.stdout.trim() !== 'amd64'
    ) {
      throw new Error('Paquet refusé : le contrôle Debian ne correspond pas au paquet libssl1.1 amd64 signé.');
    }

    const extraction = await runCommand('dpkg-deb', ['--extract', packagePath, stagingDirectory], {
      signal,
      timeoutMs: 30_000,
      maxBufferBytes: 2 * 1024 * 1024,
    });
    if (extraction.exitCode !== 0) {
      throw new Error(`Échec de l’extraction locale du paquet libssl1.1 : ${extraction.stderr.trim() || 'dpkg-deb a échoué.'}`);
    }
    const stagedLibraryDirectory = path.join(stagingDirectory, 'usr', 'lib', 'x86_64-linux-gnu');
    await Promise.all([
      assertRealLibrary(path.join(stagedLibraryDirectory, 'libssl.so.1.1')),
      assertRealLibrary(path.join(stagedLibraryDirectory, 'libcrypto.so.1.1')),
    ]);

    await writeFile(
      path.join(stagingDirectory, 'ncraft-runtime.json'),
      `${JSON.stringify({
        source: 'Ubuntu focal-updates (InRelease and Packages.gz signature/SHA-256 verified)',
        package: 'libssl1.1',
        version: packagesRecord.version,
        architecture: 'amd64',
        packageSha256: packagesRecord.sha256,
        ubuntuArchiveKeyFingerprint: [...TRUSTED_UBUNTU_ARCHIVE_FINGERPRINTS][0],
      }, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    await chmod(stagingDirectory, 0o700);
    throwIfAborted(signal);
    await rename(stagingDirectory, finalRoot);
    installed = true;
  } finally {
    await rm(downloadsDirectory, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }).catch(() => undefined);
    if (!installed) await rm(stagingDirectory, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }).catch(() => undefined);
  }
}

async function inspectLinuxBinary(
  binaryPath: string,
  librarySearchPath: string,
  signal?: AbortSignal,
): Promise<BinaryDependencyReport> {
  throwIfAborted(signal);
  const handle = await open(binaryPath, 'r');
  let isElf = false;
  try {
    const signature = Buffer.alloc(4);
    const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
    isElf = bytesRead === 4 && signature[0] === 0x7f && signature[1] === 0x45 && signature[2] === 0x4c && signature[3] === 0x46;
  } finally {
    await handle.close();
  }
  if (!isElf) return { isElf: false, missingLibraries: [], compatibilityIssues: [], output: 'bedrock_server n’est pas un exécutable ELF Linux.' };

  const environment = subprocessEnvironment({ LD_LIBRARY_PATH: librarySearchPath });
  const result = await runCommand('ldd', [binaryPath], {
    env: environment,
    signal,
    timeoutMs: 10_000,
    maxBufferBytes: 1024 * 1024,
  });
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (/not a dynamic executable|statically linked/i.test(output)) {
    return { isElf: true, missingLibraries: [], compatibilityIssues: [], output };
  }

  const missingLibraries = [...output.matchAll(/^\s*(\S+)\s+=>\s+not found\s*$/gm)]
    .map((match) => match[1]!)
    .filter((name, index, names) => names.indexOf(name) === index);
  const compatibilityIssues = output
    .split(/\r?\n/)
    .filter((line) => /version [`'‘][^`'’]+[`'’] not found|wrong ELF class|error while loading shared libraries/i.test(line))
    .filter((line, index, lines) => lines.indexOf(line) === index);
  if (result.exitCode !== 0 && missingLibraries.length === 0 && compatibilityIssues.length === 0) {
    compatibilityIssues.push(`ldd n’a pas pu inspecter le binaire (code ${result.exitCode ?? 'inconnu'}). ${result.stderr.trim()}`.trim());
  }
  return { isElf: true, missingLibraries, compatibilityIssues, output };
}

function formatDependencyFailure(report: BinaryDependencyReport): string {
  const missing = report.missingLibraries.length
    ? `bibliothèques absentes : ${report.missingLibraries.join(', ')}`
    : '';
  const incompatible = report.compatibilityIssues.length
    ? `incompatibilités : ${report.compatibilityIssues.join(' ; ')}`
    : '';
  return [missing, incompatible].filter(Boolean).join(' ; ');
}

export class BedrockRuntimeDependencies implements BedrockRuntimeSupport {
  readonly localOpenSsl11Directory: string;
  private usingLocalOpenSsl11 = false;
  private readonly inspectBinary: BinaryDependencyInspector;
  private readonly installOpenSsl11: LegacyOpenSslInstaller;

  constructor(
    private readonly dataDirectory: string,
    options: {
      inspectBinary?: BinaryDependencyInspector;
      installOpenSsl11?: LegacyOpenSslInstaller;
    } = {},
  ) {
    this.localOpenSsl11Directory = getOpenSsl11LibraryDirectory(dataDirectory);
    this.inspectBinary = options.inspectBinary ?? inspectLinuxBinary;
    this.installOpenSsl11 = options.installOpenSsl11 ?? installUbuntuFocalOpenSsl11;
  }

  libraryDirectories(): string[] {
    return this.usingLocalOpenSsl11 ? [this.localOpenSsl11Directory] : [];
  }

  async ensureForBinary(binaryPath: string, workingDirectory: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (path.dirname(path.resolve(binaryPath)) !== path.resolve(workingDirectory)) {
      throw new Error('Vérification Linux refusée : bedrock_server doit se trouver à la racine du dossier BDS.');
    }

    // Never put an unverified path in LD_LIBRARY_PATH: a symlinked or partial
    // runtime tree must not shadow the host's libraries for unrelated releases.
    this.usingLocalOpenSsl11 = await inspectBundledOpenSsl11(this.dataDirectory);
    let librarySearchPath = [
      ...this.libraryDirectories(),
      ...(process.env.LD_LIBRARY_PATH ?? '').split(path.delimiter).filter(Boolean),
    ].join(path.delimiter);

    let report = await this.inspectBinary(binaryPath, librarySearchPath, signal);
    if (!report.isElf) {
      throw new Error('Vérification Linux refusée : l’archive officielle ne fournit pas un binaire Bedrock ELF exploitable.');
    }

    const legacyOpenSslMissing = report.missingLibraries.some((name) => LEGACY_SSL_NAMES.has(name));
    if (legacyOpenSslMissing) {
      try {
        await this.installOpenSsl11(this.dataDirectory, signal);
      } catch (error) {
        const reason = (error as Error).message || 'erreur inconnue';
        throw new Error(`OpenSSL 1.1 manque au binaire Bedrock; l’installation locale vérifiée a échoué : ${reason}`);
      }
      throwIfAborted(signal);
      this.usingLocalOpenSsl11 = await inspectBundledOpenSsl11(this.dataDirectory);
      if (!this.usingLocalOpenSsl11) {
        throw new Error('Installation OpenSSL 1.1 refusée : les bibliothèques locales ne passent pas la vérification de type, taille et chemin.');
      }
      librarySearchPath = [
        ...this.libraryDirectories(),
        ...(process.env.LD_LIBRARY_PATH ?? '').split(path.delimiter).filter(Boolean),
      ].join(path.delimiter);
      report = await this.inspectBinary(binaryPath, librarySearchPath, signal);
    }

    if (report.missingLibraries.length > 0 || report.compatibilityIssues.length > 0) {
      throw new Error(`Dépendances du binaire Bedrock non satisfaites (${formatDependencyFailure(report)}). Le serveur actif n’a pas été arrêté.`);
    }
  }
}

export async function inspectBundledOpenSsl11(dataDirectory: string): Promise<boolean> {
  const directory = getOpenSsl11LibraryDirectory(dataDirectory);
  try {
    await assertNoSymlinkInPath(directory);
    await Promise.all([
      assertRealLibrary(path.join(directory, 'libssl.so.1.1')),
      assertRealLibrary(path.join(directory, 'libcrypto.so.1.1')),
    ]);
    return true;
  } catch (error) {
    if (isMissing(error) || (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    if ((error as Error).message.includes('absente, vide ou non régulière')) return false;
    if ((error as Error).message.includes('contient un lien symbolique')) return false;
    throw error;
  }
}
