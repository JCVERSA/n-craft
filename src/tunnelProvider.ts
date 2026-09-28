import type { TunnelProvider } from './types/backend.ts';

/** Portwarp is the default; Localtonet and Playit remain explicit alternatives. */
export function resolveTunnelProvider(value = process.env.TUNNEL_PROVIDER): TunnelProvider {
  const provider = value?.trim().toLowerCase();
  if (provider === 'localtonet') return 'localtonet';
  if (provider === 'playit') return 'playit';
  return 'portwarp';
}
