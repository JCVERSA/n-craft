import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class PrivateStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrivateStorageError';
  }
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new PrivateStorageError('Le dossier privé du chatbot n’est pas un dossier réel.');
  }
  await chmod(directory, 0o700);
}

async function assertRegularFileOrMissing(filePath: string): Promise<boolean> {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new PrivateStorageError('Un fichier du stockage privé du chatbot n’est pas sûr.');
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function readPrivateJson(filePath: string): Promise<unknown | null> {
  if (!(await assertRegularFileOrMissing(filePath))) return null;
  await chmod(filePath, 0o600);
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch {
    throw new PrivateStorageError('Un fichier JSON du stockage privé du chatbot est invalide.');
  }
}

export async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await ensurePrivateDirectory(directory);
  await assertRegularFileOrMissing(filePath);
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new PrivateStorageError('La valeur du stockage privé du chatbot ne peut pas être sérialisée.');

  const temporaryPath = `${filePath}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, `${serialized}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function removePrivateFile(filePath: string): Promise<void> {
  if (!(await assertRegularFileOrMissing(filePath))) return;
  await unlink(filePath);
}
