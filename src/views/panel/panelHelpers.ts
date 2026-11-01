import {
  Activity,
  Globe,
  Package,
  Paintbrush,
  Server,
  ShieldCheck,
  Terminal,
  type LucideIcon,
} from 'lucide-react';
import type { BranchedMenuItem } from '../../components/BranchedMenu.jsx';
import type { SegmentOption } from '../../components/RubberSegment.tsx';
import type { MonitoringSnapshot } from '../../monitoring.ts';
import type { MetricStorage } from '../../utils/metricHistory.ts';
import type {
  ChatbotSnapshot,
  ConsoleLog,
  DeployConfiguration,
  PersistentPanelState,
  PipelineStep,
  PlayitSetupSnapshot,
  PortwarpLoginSnapshot,
  RecoverySnapshot,
  ScheduledRestartSnapshot,
  SnapshotManagerSnapshot,
  SystemPreflight,
  TunnelProvider,
  VersionEntry,
} from '../../types/backend.ts';

export interface StatusResponse {
  state: PersistentPanelState;
  tunnelProvider: TunnelProvider;
  playitSetup: PlayitSetupSnapshot;
  portwarpSetup: PortwarpLoginSnapshot;
  system: SystemPreflight;
  serverDirectory: string;
  deployBusy: boolean;
  scheduler: ScheduledRestartSnapshot;
  chatbot: ChatbotSnapshot;
  snapshots: SnapshotManagerSnapshot;
  recovery: RecoverySnapshot;
  monitoring: MonitoringSnapshot;
}

export type PublicVersion = Omit<VersionEntry, 'downloadUrl'>;

export type PanelTabId =
  | 'overview'
  | 'deploy'
  | 'worlds'
  | 'diagnostics'
  | 'operations'
  | 'console'
  | 'pixel-studio';

export type PanelToastTone = 'success' | 'warning' | 'error' | 'info';

export interface PanelToast {
  id: number;
  tone: PanelToastTone;
  title: string;
  description: string;
}

export const PANEL_TABS: Array<{ id: PanelTabId; label: string; compactLabel: string; icon: LucideIcon }> = [
  { id: 'overview', label: 'Vue générale', compactLabel: 'Vue', icon: Server },
  { id: 'deploy', label: 'Déploiement', compactLabel: 'Déployer', icon: Package },
  { id: 'worlds', label: 'Mondes', compactLabel: 'Mondes', icon: Globe },
  { id: 'diagnostics', label: 'Diagnostics', compactLabel: 'Diag.', icon: ShieldCheck },
  { id: 'operations', label: 'Opérations', compactLabel: 'Ops', icon: Activity },
  { id: 'console', label: 'Console', compactLabel: 'Console', icon: Terminal },
  { id: 'pixel-studio', label: 'Pixel Studio', compactLabel: 'Studio', icon: Paintbrush },
];

export const BRANCHED_NAV_ITEMS: BranchedMenuItem[] = [
  {
    label: 'Serveur',
    children: [
      { value: 'overview', label: 'Vue générale' },
      { value: 'worlds', label: 'Mondes sauvegardés' },
    ],
  },
  {
    label: 'Configuration',
    children: [
      { value: 'deploy', label: 'Déploiement' },
      { value: 'console', label: 'Console Bedrock' },
    ],
  },
  {
    label: 'Supervision',
    children: [
      { value: 'diagnostics', label: 'Diagnostics système' },
      { value: 'operations', label: 'Snapshots, accès et alertes' },
    ],
  },
  {
    label: 'Création',
    children: [
      { value: 'pixel-studio', label: 'Pixel Studio' },
    ],
  },
];

export const defaultConfiguration: DeployConfiguration = {
  version: '',
  serverName: 'Nebula Craft',
  levelName: 'NebulaWorld',
  gamemode: 'survival',
  difficulty: 'normal',
  maxPlayers: 10,
  adminXuids: [''],
  seed: '',
  viewDistance: 10,
  allowCheats: false,
  eulaAccepted: false,
};

export const gameModeOptions: SegmentOption<DeployConfiguration['gamemode']>[] = [
  { value: 'survival', label: 'Survie' },
  { value: 'creative', label: 'Créatif' },
  { value: 'adventure', label: 'Aventure' },
];

export const difficultyOptions: SegmentOption<DeployConfiguration['difficulty']>[] = [
  { value: 'peaceful', label: 'Paisible' },
  { value: 'easy', label: 'Facile' },
  { value: 'normal', label: 'Normale' },
  { value: 'hard', label: 'Difficile' },
];

export const pipelineSteps: Array<{ id: PipelineStep; label: string }> = [
  { id: 'preflight', label: 'Vérification système' },
  { id: 'downloading', label: 'Téléchargement du ZIP' },
  { id: 'extracting', label: 'Extraction sécurisée en staging' },
  { id: 'stopping', label: 'Arrêt gracieux de Bedrock' },
  { id: 'updating_files', label: 'Mise à jour sans effacement des données' },
  { id: 'writing_config', label: 'Préservation / création des réglages' },
  { id: 'accepting_eula', label: 'EULA (prompt détecté uniquement)' },
  { id: 'starting', label: 'Redémarrage et contrôle' },
  { id: 'running', label: 'Serveur en ligne' },
];

export function panelTabFromHash(hash: string): PanelTabId | null {
  const value = hash.replace(/^#/, '');
  return PANEL_TABS.some((tab) => tab.id === value) ? (value as PanelTabId) : null;
}

export function initialPanelTab(): PanelTabId {
  return typeof window === 'undefined' ? 'overview' : panelTabFromHash(window.location.hash) ?? 'overview';
}

export function getMetricStorage(): MetricStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function apiRequest<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(url, {
    ...options,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const payload = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw new ApiError(payload.error || `Erreur HTTP ${response.status}.`, response.status);
  return payload;
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'inconnu';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} Go`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} Mio`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} Kio`;
  return `${bytes} o`;
}

export function formatDuration(totalSeconds: number | null): string {
  if (totalSeconds === null || !Number.isFinite(totalSeconds)) return '—';
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  const clock = [hours, minutes, remainder].map((value) => String(value).padStart(2, '0')).join(':');
  return days > 0 ? `${days} j ${clock}` : clock;
}

export function formatScheduledTime(value: string | null, timeZone: string): string {
  if (!value) return 'calcul en cours';
  return new Date(value).toLocaleString('fr-FR', {
    timeZone,
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    stopped: 'ARRÊTÉ',
    stopping: 'ARRÊT EN COURS',
    starting: 'DÉMARRAGE',
    running: 'EN LIGNE',
    failed: 'ÉCHEC',
    idle: 'INACTIF',
    address_not_detected: 'ADRESSE NON DÉTECTÉE',
    waiting_for_secret: 'CLAIM PLAYIT À FINALISER',
    claim_pending: 'APPROBATION PLAYIT EN ATTENTE',
    configuration_missing: 'CONFIGURATION MANQUANTE',
    client_missing: 'CLI PORTWARP ABSENT',
    authentication_required: 'AUTORISATION REQUISE',
    awaiting_approval: 'APPROBATION EN ATTENTE',
    tunnel_missing: 'TUNNEL À CRÉER',
    tunnel_misconfigured: 'RÈGLE UDP À CORRIGER',
    connecting: 'CONNEXION',
    exited: 'AGENT ARRÊTÉ',
  };
  return labels[status] ?? status.toUpperCase();
}

export function isValidForm(configuration: DeployConfiguration): boolean {
  return Boolean(
    configuration.version &&
    configuration.serverName.trim() &&
    configuration.levelName.trim() &&
    Number.isSafeInteger(configuration.maxPlayers) && configuration.maxPlayers > 0 &&
    Number.isSafeInteger(configuration.viewDistance) && configuration.viewDistance > 0 &&
    configuration.adminXuids.length >= 1 && configuration.adminXuids.length <= 3 &&
    configuration.adminXuids.every((xuid) => /^\d{1,20}$/.test(xuid)) &&
    new Set(configuration.adminXuids).size === configuration.adminXuids.length &&
    configuration.eulaAccepted,
  );
}

export function getWorldSettingsConfirmation(current: DeployConfiguration, next: DeployConfiguration): string | null {
  const warnings: string[] = [];
  if (current.levelName !== next.levelName) {
    warnings.push(`Bedrock utilisera le dossier worlds/${next.levelName}. S’il n’existe pas, un nouveau monde sera créé; l’ancien restera intact.`);
  }
  if (current.seed !== next.seed) {
    warnings.push('La seed ne sert qu’à générer un monde neuf; elle ne modifie pas les chunks déjà créés.');
  }
  if (warnings.length === 0) return null;
  warnings.push('Aucun monde existant ne sera supprimé ni déplacé.');
  return warnings.join('\n\n');
}

export function hasConfigurationSettingsChanged(current: DeployConfiguration, next: DeployConfiguration): boolean {
  return current.serverName !== next.serverName
    || current.levelName !== next.levelName
    || current.gamemode !== next.gamemode
    || current.difficulty !== next.difficulty
    || current.maxPlayers !== next.maxPlayers
    || current.seed !== next.seed
    || current.viewDistance !== next.viewDistance
    || current.allowCheats !== next.allowCheats
    || current.eulaAccepted !== next.eulaAccepted
    || current.adminXuids.length !== next.adminXuids.length
    || current.adminXuids.some((xuid, index) => xuid !== next.adminXuids[index]);
}

export function hasDeployConfigurationChanged(current: DeployConfiguration, next: DeployConfiguration): boolean {
  return current.version !== next.version || hasConfigurationSettingsChanged(current, next);
}

export function areJsonValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function haveSameConsoleLogIds(current: ConsoleLog[], next: ConsoleLog[]): boolean {
  return current.length === next.length && current.every((line, index) => line.id === next[index]?.id);
}
