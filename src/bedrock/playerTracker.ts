export interface PlayerLifecycleEvent {
  action: 'connected' | 'disconnected';
  playerKey: string;
}

export interface PlayerLifecycleDetails extends PlayerLifecycleEvent {
  xuid: string | null;
  name: string;
}

/** Parses Bedrock's normal Player connected/disconnected console messages. */
export function parsePlayerLifecycleDetails(message: string): PlayerLifecycleDetails | null {
  const lifecycle = message.match(/\bPlayer\s+(connected|disconnected)\s*:\s*(.+)$/i);
  if (!lifecycle) return null;

  const details = lifecycle[2].trim();
  const xuid = details.match(/(?:,|\s)\s*xuid\s*:\s*([0-9]+)/i)?.[1] ?? null;
  const name = details.replace(/\s*,?\s*xuid\s*:\s*[0-9]+.*$/i, '').trim().replace(/^['"]|['"]$/g, '');
  const identity = xuid || name;
  if (!identity) return null;

  return {
    action: lifecycle[1].toLowerCase() as PlayerLifecycleEvent['action'],
    playerKey: xuid ? `xuid:${xuid}` : `name:${name.toLocaleLowerCase()}`,
    xuid,
    name: name || `Player ${xuid?.slice(-4) ?? 'unknown'}`,
  };
}

/** Backward-compatible compact event used by existing player-count consumers. */
export function parsePlayerLifecycleMessage(message: string): PlayerLifecycleEvent | null {
  const details = parsePlayerLifecycleDetails(message);
  return details ? { action: details.action, playerKey: details.playerKey } : null;
}
