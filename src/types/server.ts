export type ScreenView = 
  | 'dashboard'
  | 'operator-auth'
  | 'chest-matrix'
  | 'node-pipeline'
  | 'f3-telemetry';

export type ServerStatus = 'RUNNING' | 'RESTARTING' | 'STOPPED' | 'DEPLOYING' | 'CRASHED';

export type GameMode = 'SURVIVAL' | 'CREATIVE' | 'ADVENTURE';

export type Difficulty = 'PEACEFUL' | 'EASY' | 'NORMAL' | 'HARD';

export interface Operator {
  name: string;
  xuid: string;
  level: number;
  badge?: string;
  isHost?: boolean;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  tag: string;
  message: string;
  level: 'info' | 'warn' | 'error' | 'success' | 'exec';
}

export interface TelemetryData {
  tps: number;
  ramUsedMb: number;
  ramTotalMb: number;
  cpuPercent: number;
  pingMs: number;
  playersOnline: number;
  playersMax: number;
  uptimeSeconds: number;
}

export interface ServerProperties {
  motd: string;
  levelName: string;
  gamemode: GameMode;
  difficulty: Difficulty;
  maxPlayers: number;
  seed: string;
  viewDistance: number;
  tickDistance: number;
  allowCheats: boolean;
  whitelistEnforced: boolean;
  engineVersion: string;
}

// Embedded authentic image assets from the prompt
export const ASSETS = {
  BEACON_LOGO: 'https://lh3.googleusercontent.com/aida/AEtjO1UdujwBCe6m1MN4iSOz0eoGjSEkKGcctFUSlcw5i-JE56AugCnhJ5k-r6sE_GAtPpL_L3c1zEjSMc5pvO1bNspi9fp4YmdrqM-Siil_Hqjx--9pzc9_sRYyDgw2KK9Q1rk_ZevU--21Sdb6x7CDEwuG-YiM7sj3NbJcBCtYc7Lype5GzUXOsarNte4KIrempA2FCOWfCLWpvhyVYaPv35W58cX64wr--RWFmFOEjwkxg-r6fksW8rFhyR7k',
  ALEX_SKIN: 'https://lh3.googleusercontent.com/aida/AEtjO1VuioYkXIZO8Fth9fWnm7xNU_h1AeWnIZwMWQ7u3m1BWbPrbxNu8gqb2_C5C5ezXudCdx7PgpZlaCTLpYY5J1SITsGI4qy2nAXNPG4dxHLZrnMRjk2MaDMwc1gm2_0qdpjI9AxGR6BQWyH8sC79UMvnMkEsFT7R83YvBsl5f8HxUEbpG5dDGJJSApxWrRcNXu_C5u4yPvHBehn7qs_mwzlVgzemYyeVTbiv192Ic4n5Ms_tiwXfdoJjhwCD',
  PANORAMA: 'https://lh3.googleusercontent.com/aida-public/AB6AXuAj2ziIHzDmZMOrthcYwwrgk7w_IXWu6TmnBVkA3zGQWkdu5k5bI9BB5Xa1o-RIDif7JidEby6rFbG76bgSywafTKOdF-_FAB57dOVeMYGWpOaOXPLay42_Ju8kMDe_0_-ei6vShYZ0J9WBLoO7_-ltdN3VX9wm5Of9iZ7F1Z7FG6mu9451mVMq0mSAMtNPAwGraGV4tdvThw54jIiBTnFddp9Tx74jH04MCUJ5y8KLqXyD3GJVPlC1Ww',
  SERVER_IP: 'nebula.craft.playit.gg:19132',
};
