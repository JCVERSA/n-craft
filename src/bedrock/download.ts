import { createWriteStream, promises as fs } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { versionDownloadHosts } from '../versionCatalog.ts';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

function assertOfficialDownloadUrl(value: string): URL {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  const pathMatches = hostname === 'minecraft.azureedge.net'
    ? /^\/bin-linux\/bedrock-server-[\d.]+\.zip$/.test(url.pathname)
    : /^\/bedrockdedicatedserver\/bin-linux\/bedrock-server-[\d.]+\.zip$/.test(url.pathname);
  if (url.protocol !== 'https:' || !versionDownloadHosts.has(hostname) || !pathMatches) {
    throw new Error('URL refusée : seules les archives Bedrock Linux officielles de Minecraft sont autorisées.');
  }
  return url;
}

async function getOfficialResponse(initialUrl: string, signal: AbortSignal): Promise<Response> {
  let url = assertOfficialDownloadUrl(initialUrl);
  for (let attempt = 0; attempt <= 5; attempt += 1) {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: { 'user-agent': 'Nebula-Craft-Panel/1.0 (+Bedrock server deploy)' },
    });
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get('location');
    if (!location || attempt === 5) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('Téléchargement refusé : redirection HTTP absente ou trop longue.');
    }
    const next = new URL(location, url);
    await response.body?.cancel().catch(() => undefined);
    url = assertOfficialDownloadUrl(next.toString());
  }
  throw new Error('Trop de redirections lors du téléchargement Bedrock.');
}

export async function downloadBedrockArchive(
  downloadUrl: string,
  destinationPath: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ bytes: number; finalUrl: string }> {
  const url = assertOfficialDownloadUrl(downloadUrl);
  const timeoutSignal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const downloadSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await getOfficialResponse(url.toString(), downloadSignal);
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Téléchargement refusé : HTTP ${response.status} (HTTP 200 requis).`);
  }

  const contentLengthHeader = response.headers.get('content-length');
  const declaredLength = contentLengthHeader ? Number(contentLengthHeader) : null;
  if (declaredLength !== null && Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body.cancel().catch(() => undefined);
    throw new Error(`Archive trop volumineuse (${declaredLength} octets ; limite ${maxBytes}).`);
  }

  let receivedBytes = 0;
  const byteLimit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      receivedBytes += chunk.byteLength;
      if (receivedBytes > maxBytes) {
        callback(new Error(`Archive trop volumineuse : dépasse la limite de ${maxBytes} octets.`));
        return;
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
      byteLimit,
      createWriteStream(destinationPath, { flags: 'wx', mode: 0o600 }),
    );
    if (receivedBytes <= 0) throw new Error('Le téléchargement a renvoyé un fichier vide.');
    if (declaredLength !== null && Number.isFinite(declaredLength) && declaredLength !== receivedBytes) {
      throw new Error(`Téléchargement incomplet : ${receivedBytes} octets reçus, ${declaredLength} attendus.`);
    }

    const handle = await fs.open(destinationPath, 'r');
    try {
      const signature = Buffer.alloc(4);
      const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
      if (bytesRead < 4 || signature[0] !== 0x50 || signature[1] !== 0x4b) {
        throw new Error('La réponse HTTP 200 ne semble pas être une archive ZIP Bedrock valide.');
      }
    } finally {
      await handle.close();
    }

    return { bytes: receivedBytes, finalUrl: response.url };
  } catch (error) {
    await fs.rm(destinationPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
