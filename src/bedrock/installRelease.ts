import { copyFile, lstat, mkdir, readdir, rename, rm, chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const PRESERVED_ROOT_FILES = new Set([
  'allowlist.json',
  'permissions.json',
  'server.properties',
  'valid_known_packs.json',
  'whitelist.json',
]);

const PRESERVED_ROOT_DIRECTORIES = new Set([
  'behavior_packs',
  'config',
  'development_behavior_packs',
  'development_resource_packs',
  'resource_packs',
  'structures',
  'world_templates',
  'worlds',
]);

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error('Mise à jour Bedrock annulée.');
}

async function existingPathType(filePath: string): Promise<'missing' | 'file' | 'directory' | 'symlink' | 'other'> {
  const info = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return 'missing';
  if (info.isSymbolicLink()) return 'symlink';
  if (info.isDirectory()) return 'directory';
  if (info.isFile()) return 'file';
  return 'other';
}

async function copyFileAtomically(source: string, destination: string, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const temporaryPath = `${destination}.${randomUUID()}.tmp`;
  try {
    await copyFile(source, temporaryPath);
    throwIfAborted(signal);
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, destination);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function mergeDirectory(
  sourceDirectory: string,
  targetDirectory: string,
  preserveExisting: boolean,
  signal?: AbortSignal,
  isRoot = false,
): Promise<void> {
  throwIfAborted(signal);
  const entries = await readdir(sourceDirectory, { withFileTypes: true });
  // Replace the executable last: if the copy is interrupted, the old binary is
  // more likely to remain runnable while all persistent world/config data stays put.
  entries.sort((left, right) => {
    const leftRank = isRoot && left.name === 'bedrock_server' ? 1 : 0;
    const rightRank = isRoot && right.name === 'bedrock_server' ? 1 : 0;
    return leftRank - rightRank || left.name.localeCompare(right.name);
  });

  for (const entry of entries) {
    throwIfAborted(signal);
    const sourcePath = path.join(sourceDirectory, entry.name);
    const targetPath = path.join(targetDirectory, entry.name);
    const targetType = await existingPathType(targetPath);

    if (preserveExisting && isRoot) {
      if (PRESERVED_ROOT_FILES.has(entry.name)) {
        if (targetType === 'symlink' || targetType === 'directory' || targetType === 'other') {
          throw new Error(`Configuration préexistante non sûre : ${targetPath}.`);
        }
        continue;
      }
      if (entry.name === 'worlds' && entry.isDirectory()) {
        if (targetType !== 'missing' && targetType !== 'directory') {
          throw new Error(`Dossier monde préexistant non sûr : ${targetPath}.`);
        }
        continue;
      }
      if (PRESERVED_ROOT_DIRECTORIES.has(entry.name) && entry.isDirectory() && targetType !== 'missing') {
        if (targetType !== 'directory') throw new Error(`Dossier de données préexistant non sûr : ${targetPath}.`);
        continue;
      }
    }

    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
      throw new Error(`Type de fichier inattendu dans le dossier de staging : ${entry.name}`);
    }

    if (entry.isDirectory()) {
      if (targetType === 'symlink' || targetType === 'file' || targetType === 'other') {
        throw new Error(`Mise à jour interrompue : ${targetPath} n’est pas un dossier sûr.`);
      }
      if (targetType === 'missing') await mkdir(targetPath, { recursive: false, mode: 0o700 });
      await mergeDirectory(sourcePath, targetPath, preserveExisting, signal, false);
      continue;
    }

    if (targetType === 'symlink' || targetType === 'directory' || targetType === 'other') {
      throw new Error(`Mise à jour interrompue : ${targetPath} n’est pas un fichier sûr.`);
    }
    if (targetType === 'missing') {
      await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
    }
    await copyFileAtomically(sourcePath, targetPath, signal);
  }
}

/**
 * Installs a staged official release by merging files, never by deleting the
 * existing server directory. Existing worlds, packs, server settings, permissions
 * and allowlists are deliberately left untouched on updates.
 */
export async function mergeBedrockRelease(
  stagingDirectory: string,
  serverDirectory: string,
  options: { preserveExisting: boolean; signal?: AbortSignal },
): Promise<void> {
  throwIfAborted(options.signal);
  const sourceType = await existingPathType(stagingDirectory);
  if (sourceType !== 'directory') throw new Error('Le dossier de staging Bedrock est absent ou non sécurisé.');

  const serverType = await existingPathType(serverDirectory);
  if (serverType === 'symlink' || serverType === 'file' || serverType === 'other') {
    throw new Error('BEDROCK_SERVER_DIR doit être un dossier réel ; aucune mise à jour n’a été écrite.');
  }
  if (serverType === 'missing') await mkdir(serverDirectory, { recursive: true, mode: 0o700 });

  await mergeDirectory(stagingDirectory, serverDirectory, options.preserveExisting, options.signal, true);
}
