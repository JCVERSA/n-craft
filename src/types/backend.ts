export type GameMode = 'survival' | 'creative' | 'adventure';
export type Difficulty = 'peaceful' | 'easy' | 'normal' | 'hard';

export interface VersionEntry {
  version: string;
  label: string;
  downloadUrl: string;
  releaseDate: string;
}

/** A complete, validated deployment request. Never contains a download URL. */
export interface DeployConfiguration {
  version: string;
  serverName: string;
  levelName: string;
  gamemode: GameMode;
  difficulty: Difficulty;
  maxPlayers: number;
  adminXuids: string[];
  seed: string;
  viewDistance: number;
  allowCheats: boolean;
  /** Explicit operator confirmation of Mojang's EULA before automatic prompt handling. */
  eulaAccepted: boolean;
}

export type PipelineStep =
  | 'idle'
  | 'preflight'
  | 'stopping'
  | 'wiping'
  | 'downloading'
  | 'extracting'
  | 'writing_config'
  | 'accepting_eula'
  | 'starting'
  | 'running'
  | 'failed';

export type PipelineStatus = 'idle' | 'running' | 'failed';
export type ServerLifecycle = 'stopped' | 'stopping' | 'starting' | 'running' | 'failed';
export type PlayitLifecycle =
  | 'starting'
  | 'running'
  | 'address_not_detected'
  | 'configuration_missing'
  | 'failed'
  | 'exited';

export interface PersistentPanelState {
  schemaVersion: 1;
  pipeline: {
    status: PipelineStatus;
    step: PipelineStep;
    error: string | null;
    updatedAt: string;
  };
  server: {
    status: ServerLifecycle;
    pid: number | null;
    startedAt: string | null;
    error: string | null;
  };
  playit: {
    status: PlayitLifecycle;
    address: string | null;
    error: string | null;
    startedAt: string | null;
    addressDetectedAt: string | null;
  };
  activeConfig: DeployConfiguration | null;
  verification: {
    eula: 'unverified' | 'prompt_accepted' | 'no_prompt_observed';
    operatorPersistence: 'unverified';
    onlineMode: false;
  };
}

export type LogLevel = 'info' | 'warn' | 'error' | 'success' | 'exec';

export interface ConsoleLog {
  id: string;
  timestamp: string;
  tag: string;
  message: string;
  level: LogLevel;
}

export interface SystemCheck {
  ok: boolean;
  detail: string;
}

export interface SystemPreflight {
  checkedAt: string;
  platform: string;
  arch: string;
  nodeVersion: string;
  glibcVersion: string | null;
  glibc: SystemCheck;
  libcurl: SystemCheck;
  memoryLimitBytes: number | null;
  memoryRequirementBytes: number;
  memoryWarning: boolean;
  diskFreeBytes: number | null;
  dataDiskFreeBytes: number | null;
  serverDiskFreeBytes: number | null;
  dataDiskRequiredBytes: number;
  serverDiskRequiredBytes: number;
  sharedDiskVolume: boolean | null;
  diskWarning: boolean;
  playitBinary: SystemCheck;
  bedrockBinary: SystemCheck;
  deployReady: boolean;
  warnings: string[];
}

export interface AuthStatus {
  configured: boolean;
  authenticated: boolean;
}
