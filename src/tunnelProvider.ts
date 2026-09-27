import type { TunnelProvider } from './types/backend.ts';

/** Localtonet is the default; Playit remains available as an explicit fallback. */
export function resolveTunnelProvider(value = process.env.TUNNEL_PROVIDER): TunnelProvider {
  return value?.trim().toLowerCase() === 'playit' ? 'playit' : 'localtonet';
}
