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
  | 'downloading'
  | 'extracting'
  | 'stopping'
  | 'updating_files'
  | 'writing_config'
  | 'accepting_eula'
  | 'starting'
  | 'running'
  | 'failed';

export type PipelineStatus = 'idle' | 'running' | 'failed';
export type ScheduledRestartPhase = 'idle' | 'countdown' | 'restarting' | 'failed';
export interface ScheduledRestartSnapshot {
  enabled: boolean;
  time: string;
  timeZone: string;
  warningMinutes: number;
  nextRestartAt: string | null;
  phase: ScheduledRestartPhase;
  countdownSeconds: number | null;
  error: string | null;
}
export type ServerLifecycle = 'stopped' | 'stopping' | 'starting' | 'running' | 'failed';
export type TunnelProvider = 'localtonet' | 'playit';
export type LocaltonetLifecycle =
  | 'starting'
  | 'running'
  | 'address_not_detected'
  | 'configuration_missing'
  | 'failed'
  | 'exited';
export interface LocaltonetState {
  status: LocaltonetLifecycle;
  address: string | null;
  error: string | null;
  startedAt: string | null;
  addressDetectedAt: string | null;
}
export type PlayitLifecycle =
  | 'starting'
  | 'waiting_for_secret'
  | 'claim_pending'
  | 'running'
  | 'address_not_detected'
  | 'configuration_missing'
  | 'failed'
  | 'exited';

export type PlayitSetupPhase = 'starting' | 'waiting_for_secret' | 'claim_pending' | 'configured' | 'failed';

/** Ephemeral, authenticated dashboard data. The one-time claim URL is never persisted. */
export interface PlayitSetupSnapshot {
  phase: PlayitSetupPhase;
  claimUrl: string | null;
  error: string | null;
}

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
    playersOnline: number | null;
    cpuPercent: number | null;
    memoryBytes: number | null;
    metricsUpdatedAt: string | null;
  };
  playit: {
    status: PlayitLifecycle;
    address: string | null;
    error: string | null;
    startedAt: string | null;
    addressDetectedAt: string | null;
  };
  localtonet: LocaltonetState;
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
  localtonetBinary: SystemCheck;
  playitBinary: SystemCheck;
  playitCliBinary: SystemCheck;
  bedrockBinary: SystemCheck;
  deployReady: boolean;
  warnings: string[];
}

export interface AuthStatus {
  configured: boolean;
  authenticated: boolean;
}
