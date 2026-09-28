export type GameMode = 'survival' | 'creative' | 'adventure';
export type Difficulty = 'peaceful' | 'easy' | 'normal' | 'hard';

export type VersionChannel = 'stable' | 'preview';

export interface VersionEntry {
  /** Exact Bedrock Dedicated Server build identifier. */
  version: string;
  /** Matching Bedrock client version shown in the release history. */
  clientVersion: string;
  channel: VersionChannel;
  label: string;
  downloadUrl: string;
  releaseDate: string | null;
}

export type WorldSource = 'created' | 'imported' | 'legacy';
export type WorldAvailability = 'ready' | 'pending' | 'missing' | 'unassigned' | 'unsafe';

export interface ManagedWorld {
  id: string;
  /** Friendly name shown in the manager; never used as a filesystem path. */
  name: string;
  /** Private folder name beneath BEDROCK_SERVER_DIR/worlds. */
  folder: string;
  /** Exact BDS build assigned to this world, null until an operator assigns it. */
  version: string | null;
  /** Configured generation seed; null means unknown (for imported/legacy worlds). */
  seed: string | null;
  configuration: DeployConfiguration | null;
  source: WorldSource;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  status: WorldAvailability;
  sizeBytes: number | null;
  lastModifiedAt: string | null;
}

export type WorldSelection =
  | { mode: 'existing'; id: string }
  | { mode: 'new'; name: string };

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
export type TunnelProvider = 'portwarp' | 'localtonet' | 'playit';
export type PortwarpLifecycle =
  | 'starting'
  | 'client_missing'
  | 'authentication_required'
  | 'awaiting_approval'
  | 'tunnel_missing'
  | 'tunnel_misconfigured'
  | 'connecting'
  | 'running'
  | 'failed';
export type PortwarpLoginPhase = 'idle' | 'starting' | 'waiting_for_approval' | 'authenticated' | 'failed';

/** Device code is exposed only to the authenticated dashboard and kept in memory. */
export interface PortwarpLoginSnapshot {
  phase: PortwarpLoginPhase;
  verificationUrl: string | null;
  userCode: string | null;
  error: string | null;
}

export interface PortwarpState {
  status: PortwarpLifecycle;
  address: string | null;
  error: string | null;
  tunnelName: string;
  localPort: number | null;
  publicPort: number | null;
  startedAt: string | null;
  addressDetectedAt: string | null;
}

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
  portwarp: PortwarpState;
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
  portwarpBinary: SystemCheck;
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
