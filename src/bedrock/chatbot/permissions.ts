import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

export type OperatorCheckResult = 'operator' | 'not_operator' | 'unknown';

/** Fail closed when the local operator list cannot be safely verified. */
export async function checkBedrockOperatorXuid(
  serverDirectory: string,
  xuid: string | null | undefined,
): Promise<OperatorCheckResult> {
  if (!xuid || !/^\d{1,20}$/.test(xuid) || xuid === '0') return 'unknown';
  const permissionsPath = path.join(serverDirectory, 'permissions.json');
  let info;
  try {
    info = await lstat(permissionsPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'not_operator';
    return 'unknown';
  }
  if (info.isSymbolicLink() || !info.isFile()) return 'unknown';

  try {
    const parsed = JSON.parse(await readFile(permissionsPath, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return 'unknown';
    const matchingOperator = parsed.some((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      const record = entry as Record<string, unknown>;
      return typeof record.xuid === 'string'
        && record.xuid === xuid
        && typeof record.permission === 'string'
        && record.permission.toLowerCase() === 'operator';
    });
    return matchingOperator ? 'operator' : 'not_operator';
  } catch {
    return 'unknown';
  }
}
