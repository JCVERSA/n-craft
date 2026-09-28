export const MAX_ARCHIVE_ENTRIES = 20_000;
export const MAX_UNPACKED_BYTES = 4 * 1024 * 1024 * 1024;
export const DISK_HEADROOM_BYTES = 512 * 1024 * 1024;
export const DEFAULT_MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;

export function getMaxArchiveBytes(): number {
  const configured = Number(process.env.BDS_MAX_ZIP_BYTES);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_ARCHIVE_BYTES;
}
