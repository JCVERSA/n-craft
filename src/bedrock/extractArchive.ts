import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import yauzl from 'yauzl';
import { MAX_ARCHIVE_ENTRIES, MAX_UNPACKED_BYTES } from './limits.ts';

function safeTargetPath(rootDirectory: string, fileName: string): { target: string; directory: boolean } {
  const normalized = fileName.replace(/\\/g, '/');
  if (!normalized || normalized.includes('\0') || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`Entrée ZIP avec un chemin absolu ou invalide : ${fileName}`);
  }
  const parts = normalized.split('/').filter((part) => part && part !== '.');
  if (parts.some((part) => part === '..')) throw new Error(`Entrée ZIP hors du dossier serveur : ${fileName}`);
  if (parts.length === 0) return { target: rootDirectory, directory: true };

  const target = path.resolve(rootDirectory, ...parts);
  const root = path.resolve(rootDirectory);
  if (!target.startsWith(`${root}${path.sep}`) && target !== root) {
    throw new Error(`Entrée ZIP hors du dossier serveur : ${fileName}`);
  }

  return {
    target,
    directory: normalized.endsWith('/'),
  };
}

/** Extracts an official archive without zip-slip paths, ZIP symlinks, or unbounded expansion. */
export async function extractZipSafely(zipPath: string, destination: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const root = path.resolve(destination);
  await mkdir(root, { recursive: true });
  signal?.throwIfAborted();

  const zipFile = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(
      zipPath,
      {
        lazyEntries: true,
        autoClose: false,
        decodeStrings: true,
        validateEntrySizes: true,
        strictFileNames: true,
      },
      (error, file) => {
        if (error || !file) reject(error ?? new Error('Impossible d’ouvrir l’archive ZIP.'));
        else resolve(file);
      },
    );
  });

  if (signal?.aborted) {
    zipFile.close();
    signal.throwIfAborted();
  }

  await new Promise<void>((resolve, reject) => {
    let finished = false;
    let entryCount = 0;
    let totalUnpackedBytes = 0;
    let activeReadStream: Readable | null = null;

    const detachAbort = () => signal?.removeEventListener('abort', onAbort);
    const closeZip = () => {
      try { zipFile.close(); } catch { /* already closed */ }
    };
    const fail = (error: Error) => {
      if (finished) return;
      finished = true;
      detachAbort();
      activeReadStream?.destroy();
      closeZip();
      reject(error);
    };
    const onAbort = () => {
      const reason = signal?.reason;
      fail(reason instanceof Error ? reason : new Error('Extraction Bedrock annulée.'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    zipFile.on('error', fail);
    zipFile.on('end', () => {
      if (finished) return;
      finished = true;
      detachAbort();
      closeZip();
      resolve();
    });

    zipFile.on('entry', (entry) => {
      if (finished) return;
      if (signal?.aborted) return onAbort();
      entryCount += 1;
      totalUnpackedBytes += entry.uncompressedSize;
      if (entryCount > MAX_ARCHIVE_ENTRIES) return fail(new Error('Archive refusée : nombre d’entrées excessif.'));
      if (totalUnpackedBytes > MAX_UNPACKED_BYTES) return fail(new Error('Archive refusée : taille décompressée excessive.'));
      if ((entry.generalPurposeBitFlag & 0x1) !== 0) return fail(new Error('Archive ZIP chiffrée non prise en charge.'));

      let target: string;
      let directory: boolean;
      try {
        const safe = safeTargetPath(root, entry.fileName);
        target = safe.target;
        const unixMode = (entry.externalFileAttributes >>> 16) & 0xFFFF;
        const fileType = unixMode & 0o170000;
        if (fileType === 0o120000) return fail(new Error(`Lien symbolique interdit dans l’archive : ${entry.fileName}`));
        if (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000) {
          return fail(new Error(`Type de fichier non pris en charge dans l’archive : ${entry.fileName}`));
        }
        directory = safe.directory || fileType === 0o040000;
      } catch (error) {
        return fail(error as Error);
      }

      if (directory) {
        void mkdir(target, { recursive: true })
          .then(() => {
            if (finished) return;
            if (signal?.aborted) return onAbort();
            zipFile.readEntry();
          })
          .catch((error) => fail(error as Error));
        return;
      }

      void mkdir(path.dirname(target), { recursive: true })
        .then(() => new Promise<Readable>((resolveStream, rejectStream) => {
          zipFile.openReadStream(entry, (error, stream) => {
            if (error || !stream) rejectStream(error ?? new Error(`Impossible de lire ${entry.fileName}.`));
            else resolveStream(stream);
          });
        }))
        .then(async (readStream) => {
          if (finished || signal?.aborted) {
            readStream.destroy();
            if (!finished) onAbort();
            return;
          }
          activeReadStream = readStream;
          if (signal) {
            await pipeline(readStream, createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal });
          } else {
            await pipeline(readStream, createWriteStream(target, { flags: 'wx', mode: 0o600 }));
          }
          activeReadStream = null;
          if (finished) return;
          if (signal?.aborted) return onAbort();
          zipFile.readEntry();
        })
        .catch((error) => fail(error as Error));
    });

    zipFile.readEntry();
  });
}
