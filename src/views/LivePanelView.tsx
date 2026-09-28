import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Copy,
  Database,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileUp,
  Globe,
  Info,
  Layers,
  Loader2,
  LockKeyhole,
  MessageCircle,
  LogOut,
  Package,
  Pencil,
  Play,
  Power,
  RefreshCw,
  Save,
  Server,
  ShieldCheck,
  Trash2,
  Terminal,
  Users,
  Wifi,
  X,
} from 'lucide-react';
import { AboutModal } from '../components/AboutModal.tsx';
import { NebulaBrandMark } from '../components/NebulaBrandMark.tsx';
import { useDialogs } from '../components/DialogProvider.tsx';
import { NetherAmbientBackground } from '../components/NetherAmbientBackground.tsx';
import { BedrockMetricsChart } from '../components/BedrockMetricsChart.tsx';
import BranchedMenu, { type BranchedMenuItem } from '../components/BranchedMenu.jsx';
import FuseButton from '../components/FuseButton.jsx';
import { GlideSelect, type GlideSelectOption } from '../components/GlideSelect.tsx';
import JellyRadio from '../components/JellyRadio.jsx';
import { NetherCard } from '../components/NetherCard.tsx';
import RefineFrame from '../components/RefineFrame.jsx';
import { RubberSegment, type SegmentOption } from '../components/RubberSegment.tsx';
import { SpringCheck } from '../components/SpringCheck.tsx';
import SwipeRow from '../components/SwipeRow.jsx';
import SwipeToast from '../components/SwipeToast.jsx';
import {
  appendMetricSample,
  loadMetricHistory,
  normalizeMetricHistory,
  saveMetricHistory,
  type BedrockMetricSample,
  type MetricStorage,
} from '../utils/metricHistory.ts';
import type {
  AuthStatus,
  ConsoleLog,
  ChatbotSnapshot,
  DeployConfiguration,
  PersistentPanelState,
  PipelineStep,
  PlayitSetupSnapshot,
  PortwarpLoginSnapshot,
  ScheduledRestartSnapshot,
  SystemPreflight,
  TunnelProvider,
  VersionEntry,
  ManagedWorld,
} from '../types/backend.ts';

interface StatusResponse {
  state: PersistentPanelState;
  tunnelProvider: TunnelProvider;
  playitSetup: PlayitSetupSnapshot;
  portwarpSetup: PortwarpLoginSnapshot;
  system: SystemPreflight;
  serverDirectory: string;
  deployBusy: boolean;
  scheduler: ScheduledRestartSnapshot;
  chatbot: ChatbotSnapshot;
}

type PublicVersion = Omit<VersionEntry, 'downloadUrl'>;

type PanelTabId = 'overview' | 'deploy' | 'worlds' | 'diagnostics' | 'console';
type TabNavigation = 'desktop' | 'mobile';

const PANEL_TABS: Array<{ id: PanelTabId; label: string; icon: LucideIcon }> = [
  { id: 'overview', label: 'Vue générale', icon: Server },
  { id: 'deploy', label: 'Déploiement', icon: Package },
  { id: 'worlds', label: 'Mondes', icon: Globe },
  { id: 'diagnostics', label: 'Diagnostics', icon: ShieldCheck },
  { id: 'console', label: 'Console', icon: Terminal },
];

type PanelToastTone = 'success' | 'warning' | 'error' | 'info';
interface PanelToast { id: number; tone: PanelToastTone; title: string; description: string; }

const BRANCHED_NAV_ITEMS: BranchedMenuItem[] = [
  { label: 'Serveur', children: [
    { value: 'overview', label: 'Vue générale' },
    { value: 'worlds', label: 'Mondes sauvegardés' },
  ] },
  { label: 'Configuration', children: [
    { value: 'deploy', label: 'Déploiement' },
    { value: 'console', label: 'Console Bedrock' },
  ] },
  { label: 'Supervision', children: [
    { value: 'diagnostics', label: 'Diagnostics système' },
  ] },
];

const PANEL_TOAST_LOOKS: Record<PanelToastTone, { background: string; fuse: string; icon: ReactNode }> = {
  success: { background: 'rgba(18, 34, 28, 0.98)', fuse: '#9be6b0', icon: <CheckCircle2 size={17} /> },
  warning: { background: 'rgba(43, 31, 18, 0.98)', fuse: '#ffb875', icon: <AlertTriangle size={17} /> },
  error: { background: 'rgba(47, 22, 27, 0.98)', fuse: '#ff7f79', icon: <AlertTriangle size={17} /> },
  info: { background: 'rgba(28, 22, 39, 0.98)', fuse: '#c5a0ff', icon: <Info size={17} /> },
};

function panelTabFromHash(hash: string): PanelTabId | null {
  const value = hash.replace(/^#/, '');
  return PANEL_TABS.some((tab) => tab.id === value) ? value as PanelTabId : null;
}

function initialPanelTab(): PanelTabId {
  return typeof window === 'undefined' ? 'overview' : panelTabFromHash(window.location.hash) ?? 'overview';
}

function getMetricStorage(): MetricStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function apiRequest<T>(url: string, options: RequestInit = {}): Promise<T> {
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

const defaultConfiguration: DeployConfiguration = {
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

const gameModeOptions: SegmentOption<DeployConfiguration['gamemode']>[] = [
  { value: 'survival', label: 'Survie' },
  { value: 'creative', label: 'Créatif' },
  { value: 'adventure', label: 'Aventure' },
];

const difficultyOptions: SegmentOption<DeployConfiguration['difficulty']>[] = [
  { value: 'peaceful', label: 'Paisible' },
  { value: 'easy', label: 'Facile' },
  { value: 'normal', label: 'Normale' },
  { value: 'hard', label: 'Difficile' },
];

const pipelineSteps: Array<{ id: PipelineStep; label: string }> = [
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

function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'inconnu';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} Go`;
  return `${(bytes / 1024 ** 2).toFixed(0)} Mio`;
}

function formatDuration(totalSeconds: number | null): string {
  if (totalSeconds === null || !Number.isFinite(totalSeconds)) return '—';
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  const clock = [hours, minutes, remainder].map((value) => String(value).padStart(2, '0')).join(':');
  return days > 0 ? `${days} j ${clock}` : clock;
}

function formatScheduledTime(value: string | null, timeZone: string): string {
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

function statusLabel(status: string): string {
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

function isValidForm(configuration: DeployConfiguration): boolean {
  return Boolean(
    configuration.version &&
    configuration.serverName.trim() &&
    configuration.levelName.trim() &&
    Number.isSafeInteger(configuration.maxPlayers) && configuration.maxPlayers > 0 &&
    Number.isSafeInteger(configuration.viewDistance) && configuration.viewDistance > 0 &&
    configuration.adminXuids.length >= 1 && configuration.adminXuids.length <= 3 &&
    configuration.adminXuids.every((xuid) => /^\d{1,20}$/.test(xuid)) &&
    new Set(configuration.adminXuids).size === configuration.adminXuids.length &&
    configuration.eulaAccepted
  );
}

function getWorldSettingsConfirmation(current: DeployConfiguration, next: DeployConfiguration): string | null {
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

function hasConfigurationSettingsChanged(current: DeployConfiguration, next: DeployConfiguration): boolean {
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

export function LivePanelView() {
  const dialogs = useDialogs();
  const [aboutOpen, setAboutOpen] = useState(false);
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  const [activeSection, setActiveSection] = useState<PanelTabId>(initialPanelTab);
  const previousActiveSectionRef = useRef(activeSection);
  const animatePanelEntry = previousActiveSectionRef.current !== activeSection;
  const [navMenuOpen, setNavMenuOpen] = useState(false);
  const navMenuRef = useRef<HTMLDivElement>(null);
  const navMenuButtonRef = useRef<HTMLButtonElement>(null);
  const [token, setToken] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [metricHistory, setMetricHistory] = useState<BedrockMetricSample[]>(() => loadMetricHistory(getMetricStorage()));
  const reduceMotion = useReducedMotion();
  const [panelToasts, setPanelToasts] = useState<PanelToast[]>([]);
  const toastSequenceRef = useRef(0);
  const pushPanelToast = useCallback((toast: Omit<PanelToast, 'id'>) => {
    const next = { ...toast, id: ++toastSequenceRef.current };
    setPanelToasts((current) => [...current.slice(-2), next]);
  }, []);
  const dismissPanelToast = useCallback((id: number) => {
    setPanelToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);
  const switchPanel = useCallback((nextTab: PanelTabId) => {
    setNavMenuOpen(false);
    setActiveSection(nextTab);
    if (typeof window === 'undefined') return;
    const nextHash = `#${nextTab}`;
    if (window.location.hash !== nextHash) window.history.pushState({ ncraftTab: nextTab }, '', nextHash);
    window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
  }, [reduceMotion]);
  const handleTabKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>, currentTab: PanelTabId, navigation: TabNavigation) => {
    const currentIndex = PANEL_TABS.findIndex((tab) => tab.id === currentTab);
    let nextIndex = currentIndex;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % PANEL_TABS.length;
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + PANEL_TABS.length) % PANEL_TABS.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = PANEL_TABS.length - 1;
    else return;
    event.preventDefault();
    const nextTab = PANEL_TABS[nextIndex];
    switchPanel(nextTab.id);
    window.requestAnimationFrame(() => document.getElementById(`${navigation}-tab-${nextTab.id}`)?.focus());
  }, [switchPanel]);

  useEffect(() => {
    if (!navMenuOpen) return undefined;
    const handleOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !navMenuRef.current?.contains(event.target)) setNavMenuOpen(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setNavMenuOpen(false);
      navMenuButtonRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', handleOutsidePointer, true);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('pointerdown', handleOutsidePointer, true);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [navMenuOpen]);

  const [versions, setVersions] = useState<PublicVersion[]>([]);
  const [worlds, setWorlds] = useState<ManagedWorld[]>([]);
  const [configuration, setConfiguration] = useState<DeployConfiguration>(defaultConfiguration);
  const [selectedWorldId, setSelectedWorldId] = useState<string | null>(null);
  const [worldEditId, setWorldEditId] = useState<string | null>(null);
  const [newWorldName, setNewWorldName] = useState('Nouveau monde');
  const [worldImportFile, setWorldImportFile] = useState<File | null>(null);
  const [worldImportName, setWorldImportName] = useState('');
  const [worldImportVersion, setWorldImportVersion] = useState('');
  const [worldBusyId, setWorldBusyId] = useState<string | null>(null);
  const [worldSwipeNonce, setWorldSwipeNonce] = useState<Record<string, number>>({});
  const [worldManagerError, setWorldManagerError] = useState('');
  const [renameWorldId, setRenameWorldId] = useState<string | null>(null);
  const [renameWorldValue, setRenameWorldValue] = useState('');
  const [assignWorldVersion, setAssignWorldVersion] = useState<Record<string, string>>({});
  const [configTouched, setConfigTouched] = useState(false);
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState('');
  const [chatbotBusy, setChatbotBusy] = useState(false);
  const [chatbotFeedback, setChatbotFeedback] = useState('');
  const [busyAction, setBusyAction] = useState<'deploy' | 'save-config' | 'start' | 'stop' | 'playit' | 'portwarp' | 'logout' | null>(null);
  const [consoleLogs, setConsoleLogs] = useState<ConsoleLog[]>([]);
  const [consoleConnected, setConsoleConnected] = useState(false);
  const [command, setCommand] = useState('');
  const [consoleError, setConsoleError] = useState('');
  const socketRef = useRef<WebSocket | null>(null);
  const logViewportRef = useRef<HTMLDivElement>(null);
  const worldImportInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    previousActiveSectionRef.current = activeSection;
  }, [activeSection]);

  const isPipelineBusy = Boolean(status?.deployBusy || status?.state.pipeline.status === 'running' || busyAction === 'deploy' || busyAction === 'save-config' || busyAction === 'start');
  const currentStepIndex = useMemo(
    () => pipelineSteps.findIndex((step) => step.id === status?.state.pipeline.step),
    [status?.state.pipeline.step],
  );

  const refreshWorlds = useCallback(async () => {
    try {
      const result = await apiRequest<{ worlds: ManagedWorld[] }>('/api/server/worlds');
      setWorlds(result.worlds);
      return result.worlds;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setAuthenticated(false);
        setStatus(null);
      } else {
        setWorldManagerError((error as Error).message);
      }
      return [];
    }
  }, []);

  const refreshStatus = useCallback(async (forceConfiguration = false) => {
    try {
      const next = await apiRequest<StatusResponse>('/api/server/status');
      setStatus(next);
      if (next.state.activeConfig && (!configTouched || forceConfiguration)) setConfiguration(next.state.activeConfig);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setAuthenticated(false);
        setStatus(null);
      } else {
        setNotice((error as Error).message);
      }
    }
  }, [configTouched]);

  useEffect(() => {
    saveMetricHistory(metricHistory, getMetricStorage());
  }, [metricHistory]);

  useEffect(() => {
    const server = status?.state.server;
    if (!authenticated || server?.status !== 'running' || !server.metricsUpdatedAt) return;
    const timestamp = Date.parse(server.metricsUpdatedAt);
    if (!Number.isSafeInteger(timestamp)) return;
    setMetricHistory((current) => appendMetricSample(current, {
      timestamp,
      cpuPercent: server.cpuPercent,
      memoryBytes: server.memoryBytes,
    }));
  }, [authenticated, status?.state.server.status, status?.state.server.metricsUpdatedAt, status?.state.server.cpuPercent, status?.state.server.memoryBytes]);

  useEffect(() => {
    let timer: number | undefined;
    const trimHistory = () => setMetricHistory((current) => normalizeMetricHistory(current));
    const stopTrimming = () => {
      if (timer === undefined) return;
      window.clearInterval(timer);
      timer = undefined;
    };
    const startTrimming = () => {
      if (document.visibilityState !== 'visible' || timer !== undefined) return;
      trimHistory();
      timer = window.setInterval(trimHistory, 10_000);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') startTrimming();
      else stopTrimming();
    };
    startTrimming();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      stopTrimming();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void apiRequest<AuthStatus>('/api/auth/status')
      .then((result) => {
        if (!alive) return;
        setAuthStatus(result);
        setAuthenticated(result.authenticated);
      })
      .catch((error) => {
        if (alive) setLoginError((error as Error).message);
      })
      .finally(() => {
        if (alive) setAuthLoading(false);
      });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    const restorePanelFromUrl = () => {
      const nextTab = panelTabFromHash(window.location.hash);
      if (nextTab) setActiveSection(nextTab);
      else if (window.location.hash === '') setActiveSection('overview');
    };
    window.addEventListener('popstate', restorePanelFromUrl);
    window.addEventListener('hashchange', restorePanelFromUrl);
    return () => {
      window.removeEventListener('popstate', restorePanelFromUrl);
      window.removeEventListener('hashchange', restorePanelFromUrl);
    };
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    let initialFetchStarted = false;
    let interval: number | undefined;
    const stopPolling = () => {
      if (interval === undefined) return;
      window.clearInterval(interval);
      interval = undefined;
    };
    const startPolling = () => {
      if (document.visibilityState !== 'visible' || interval !== undefined) return;
      if (!initialFetchStarted) {
        initialFetchStarted = true;
        void Promise.all([
          apiRequest<{ versions: PublicVersion[] }>('/api/server/versions'),
          apiRequest<StatusResponse>('/api/server/status'),
          apiRequest<{ worlds: ManagedWorld[] }>('/api/server/worlds'),
        ]).then(([catalog, nextStatus, worldResult]) => {
          if (cancelled) return;
          setVersions(catalog.versions);
          setStatus(nextStatus);
          setWorlds(worldResult.worlds);
          const currentConfig = nextStatus.state.activeConfig;
          const activeWorld = currentConfig
            ? worldResult.worlds.find((world) => world.version === currentConfig.version && world.folder === currentConfig.levelName)
            : undefined;
          if (currentConfig && !configTouched) {
            setConfiguration(currentConfig);
            setSelectedWorldId(activeWorld?.id ?? null);
            setNewWorldName('Nouveau monde');
            setConfigTouched(false);
          }
          setWorldImportVersion(currentConfig?.version ?? catalog.versions[0]?.version ?? '');
        }).catch((error) => {
          if (cancelled) return;
          if (error instanceof ApiError && error.status === 401) setAuthenticated(false);
          else setNotice((error as Error).message);
        });
      } else {
        void refreshStatus();
      }
      interval = window.setInterval(() => { void refreshStatus(); }, 2500);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') startPolling();
      else stopPolling();
    };
    startPolling();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      cancelled = true;
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [authenticated, configTouched, refreshStatus]);

  useEffect(() => {
    if (!authenticated) return;
    let disposed = false;
    let reconnectTimer: number | undefined;
    let currentSocket: WebSocket | null = null;

    const connect = () => {
      if (disposed) return;
      const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      currentSocket = new WebSocket(`${scheme}//${window.location.host}/api/server/console`);
      socketRef.current = currentSocket;
      currentSocket.onopen = () => {
        setConsoleConnected(true);
        setConsoleError('');
      };
      currentSocket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as {
            type?: string;
            line?: ConsoleLog;
            lines?: ConsoleLog[];
            error?: string;
            state?: PersistentPanelState;
          };
          if (message.type === 'snapshot' && Array.isArray(message.lines)) {
            setConsoleLogs(message.lines.slice(-500));
            if (message.state) setStatus((current) => current ? { ...current, state: message.state! } : current);
          } else if (message.type === 'line' && message.line) {
            setConsoleLogs((previous) => [...previous.slice(-499), message.line!]);
          } else if (message.type === 'state' && message.state) {
            setStatus((current) => current ? { ...current, state: message.state! } : current);
          } else if (message.type === 'error' && message.error) {
            setConsoleError(message.error);
          }
        } catch {
          setConsoleError('Message WebSocket invalide.');
        }
      };
      currentSocket.onclose = () => {
        setConsoleConnected(false);
        if (!disposed) reconnectTimer = window.setTimeout(connect, 2500);
      };
      currentSocket.onerror = () => {
        setConsoleConnected(false);
      };
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      currentSocket?.close();
      socketRef.current = null;
      setConsoleConnected(false);
    };
  }, [authenticated]);

  useEffect(() => {
    const viewport = logViewportRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [consoleLogs, activeSection]);

  useEffect(() => {
    if (versions.length > 0 && !configuration.version && !status?.state.activeConfig) {
      setConfiguration((current) => ({ ...current, version: versions[0].version }));
    }
  }, [versions, configuration.version, status?.state.activeConfig]);

  useEffect(() => {
    if (authenticated && status?.state.server.status === 'running') void refreshWorlds();
  }, [authenticated, status?.state.server.status, refreshWorlds]);

  const markConfigTouched = () => {
    setConfigTouched(true);
    setFormError('');
    setNotice('');
  };

  const changeField = <K extends keyof DeployConfiguration>(key: K, value: DeployConfiguration[K]) => {
    markConfigTouched();
    if (key === 'version') {
      setSelectedWorldId(null);
      setWorldEditId(null);
    }
    setConfiguration((current) => ({ ...current, [key]: value }));
  };

  const chooseWorld = (world: ManagedWorld, editSettings: boolean) => {
    if (!world.version || world.status !== 'ready') return;
    const fallback = configuration;
    const next = world.configuration ?? fallback;
    setSelectedWorldId(world.id);
    setWorldEditId(editSettings ? world.id : null);
    setConfiguration({
      ...next,
      version: world.version,
      levelName: world.folder,
      seed: world.seed ?? '',
      eulaAccepted: next.eulaAccepted || fallback.eulaAccepted,
    });
    setConfigTouched(true);
    setFormError('');
    setNotice('');
    setWorldManagerError('');
    switchPanel('deploy');
  };

  const chooseNewWorld = () => {
    setSelectedWorldId(null);
    setWorldEditId(null);
    setNewWorldName(`Nouveau monde ${worlds.filter((world) => world.version === configuration.version).length + 1}`);
    setConfigTouched(true);
    setFormError('');
    switchPanel('deploy');
  };

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoginBusy(true);
    setLoginError('');
    try {
      await apiRequest<{ authenticated: boolean }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
      setToken('');
      setShowToken(false);
      setAuthenticated(true);
      setAuthStatus((current) => current ? { ...current, authenticated: true } : current);
    } catch (error) {
      setLoginError((error as Error).message);
      setToken('');
      setShowToken(false);
    } finally {
      setLoginBusy(false);
    }
  };

  const handleLogout = async () => {
    setBusyAction('logout');
    try {
      await apiRequest<{ authenticated: boolean }>('/api/auth/logout', { method: 'POST', body: '{}' });
      setAuthenticated(false);
      setAuthStatus((current) => current ? { ...current, authenticated: false } : current);
      setStatus(null);
      setConsoleLogs([]);
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusyAction(null);
    }
  };

  const handleDeploy = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError('');
    setNotice('');
    const currentConfig = status?.state.activeConfig;
    const targetWorld = selectedWorldId ? worlds.find((world) => world.id === selectedWorldId) : undefined;
    if (status?.state.server.status === 'running') {
      setFormError('Arrête Bedrock avant de modifier la configuration ou la version.');
      return;
    }
    if (!isValidForm(configuration)) {
      setFormError('Complète les champs requis, fournis 1 à 3 XUID numériques uniques et confirme l’EULA.');
      return;
    }
    if (!versions.some((version) => version.version === configuration.version)) {
      setFormError('Choisis une version Bedrock disponible dans le catalogue vérifié.');
      return;
    }
    if (targetWorld && (targetWorld.status !== 'ready' || targetWorld.version !== configuration.version)) {
      setFormError('Le monde choisi doit être complet et appartenir à la version BDS sélectionnée.');
      return;
    }
    if (status?.system.deployReady === false) {
      setFormError('Démarrage bloqué : les dépendances Linux obligatoires (glibc/libcurl) ne sont pas toutes détectées. Consulte les contrôles système ci-dessous.');
      return;
    }

    const targetConfiguration = {
      ...configuration,
      levelName: targetWorld?.folder ?? newWorldName.trim(),
      seed: targetWorld ? targetWorld.seed ?? '' : configuration.seed,
    };
    const worldDescription = targetWorld
      ? `Reprendre « ${targetWorld.name} » avec son dossier et sa progression existants (BDS ${targetWorld.version}).`
      : `Créer un nouveau monde « ${newWorldName.trim()} » dédié à BDS ${configuration.version}.`;
    const versionOperation = !currentConfig || currentConfig.version !== configuration.version;
    const confirmationMessage = [
      `Destination serveur : ${status?.serverDirectory ?? 'BEDROCK_SERVER_DIR'}.`,
      worldDescription,
      versionOperation
        ? isExistingDeployment
          ? 'Mise à jour non destructive : les mondes, sauvegardes, packs, permissions et fichiers inconnus sont conservés. Les réglages modifiés seront appliqués.'
          : 'Première installation : aucun monde ni fichier existant ne sera supprimé ou remplacé.'
        : 'Le binaire BDS déjà installé sera réutilisé ; aucun téléchargement de version ne sera effectué.',
      'Bedrock doit être arrêté. Après cette opération, il démarrera automatiquement; le tunnel restera actif.',
      status?.system.memoryWarning ? 'Le conteneur est sous le budget mémoire recommandé ; un arrêt OOM est possible.' : '',
      status?.system.diskWarning && versionOperation ? `Espace disque détecté : DATA_DIR ${formatBytes(status.system.dataDiskFreeBytes)} libres / ${formatBytes(status.system.dataDiskRequiredBytes)} estimés${status.system.sharedDiskVolume === false ? ` ; BEDROCK_SERVER_DIR ${formatBytes(status.system.serverDiskFreeBytes)} libres / ${formatBytes(status.system.serverDiskRequiredBytes)} estimés` : status.system.sharedDiskVolume === null ? ' ; volume de BEDROCK_SERVER_DIR incertain' : ' ; volume partagé, archive + extraction incluses'}. Le déploiement reste autorisé, mais peut échouer si le volume est plein.` : '',
    ].filter(Boolean).join('\n\n');
    const confirmed = await dialogs.confirm({
      title: versionOperation ? `Déployer BDS ${configuration.version} ?` : `Démarrer le monde avec BDS ${configuration.version} ?`,
      message: confirmationMessage,
      eyebrow: 'OPÉRATION BEDROCK · VÉRIFICATION',
      tone: 'warning',
      confirmLabel: versionOperation ? 'Déployer & démarrer' : 'Démarrer le monde',
      cancelLabel: 'Annuler',
    });
    if (!confirmed) return;

    setBusyAction('deploy');
    try {
      const deployment = await apiRequest<{ worldId: string }>('/api/server/deploy', {
        method: 'POST',
        body: JSON.stringify({
          config: targetConfiguration,
          world: targetWorld
            ? { mode: 'existing', id: targetWorld.id }
            : { mode: 'new', name: newWorldName.trim() },
        }),
      });
      setSelectedWorldId(deployment.worldId);
      setConfigTouched(false);
      setWorldEditId(null);
      setNotice('Opération acceptée. Suis le démarrage du monde et l’état du serveur dans le tableau de bord.');
      await Promise.all([refreshStatus(true), refreshWorlds()]);
    } catch (error) {
      setFormError((error as Error).message);
    } finally {
      setBusyAction(null);
    }
  };

  const handleSaveConfiguration = async () => {
    setFormError('');
    setNotice('');
    const currentConfig = status?.state.activeConfig;
    if (!currentConfig) {
      setFormError('Aucune configuration Bedrock existante à modifier.');
      return;
    }
    if (isPipelineBusy || status?.state.server.status === 'running') {
      setFormError('Arrête Bedrock avant de modifier sa configuration. Le tunnel restera actif.');
      return;
    }
    if (configuration.version !== currentConfig.version) {
      setFormError('Pour changer la version Bedrock, utilise l’action de mise à jour.');
      return;
    }
    if (!hasConfigurationSettingsChanged(currentConfig, configuration)) return;
    if (!isValidForm(configuration)) {
      setFormError('Vérifie les champs requis, les XUID uniques et la confirmation de l’EULA.');
      return;
    }
    const worldWarning = getWorldSettingsConfirmation(currentConfig, configuration);
    if (worldWarning) {
      const confirmed = await dialogs.confirm({
        title: 'Appliquer ces réglages ?',
        message: `${worldWarning}\n\nBedrock restera arrêté; le tunnel ne sera pas coupé.`,
        eyebrow: 'MODIFICATION DU MONDE',
        tone: 'warning',
        confirmLabel: 'Enregistrer les réglages',
        cancelLabel: 'Revenir aux réglages',
      });
      if (!confirmed) return;
    }

    setBusyAction('save-config');
    try {
      await apiRequest('/api/server/configuration', {
        method: 'POST',
        body: JSON.stringify({ config: configuration }),
      });
      setConfiguration(configuration);
      setConfigTouched(false);
      setNotice('Réglages enregistrés. Bedrock reste arrêté; tu peux le démarrer quand tu veux. Le tunnel reste actif.');
      await Promise.all([refreshStatus(true), refreshWorlds()]);
    } catch (error) {
      setFormError((error as Error).message);
    } finally {
      setBusyAction(null);
    }
  };

  const handleSaveWorldSettings = async () => {
    const world = worldEditId ? worlds.find((candidate) => candidate.id === worldEditId) : undefined;
    if (!world || !world.version) {
      setWorldManagerError('Choisis un monde attribué à une version BDS avant de modifier ses options.');
      return;
    }
    if (isPipelineBusy || status?.state.server.status === 'running' || (status?.state.server.status === 'failed' && status.state.server.pid !== null)) {
      setWorldManagerError('Arrête Bedrock avant de modifier les options d’un monde.');
      return;
    }
    if (!isValidForm(configuration)) {
      setWorldManagerError('Vérifie les options, les XUID administrateur et l’acceptation de l’EULA.');
      return;
    }
    const nextConfiguration = {
      ...configuration,
      version: world.version,
      levelName: world.folder,
      seed: world.seed ?? '',
    };
    setWorldBusyId(world.id);
    setWorldManagerError('');
    try {
      await apiRequest<{ world: ManagedWorld }>(`/api/server/worlds/${encodeURIComponent(world.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ configuration: nextConfiguration }),
      });
      const active = status?.state.activeConfig;
      const editsActiveWorld = active?.version === world.version && active.levelName === world.folder;
      setWorldEditId(null);
      setConfigTouched(!editsActiveWorld);
      pushPanelToast({
        tone: 'success',
        title: 'Réglages enregistrés',
        description: editsActiveWorld
          ? 'Les options sont enregistrées. Bedrock reste arrêté; les chunks et la seed n’ont pas été modifiés.'
          : 'Les options seront appliquées lorsque tu reprendras ce monde. Bedrock reste inchangé.',
      });
      await Promise.all([refreshWorlds(), ...(editsActiveWorld ? [refreshStatus(true)] : [])]);
    } catch (error) {
      setWorldManagerError((error as Error).message);
    } finally {
      setWorldBusyId(null);
    }
  };

  const handleRenameWorld = async (world: ManagedWorld) => {
    setWorldBusyId(world.id);
    setWorldManagerError('');
    try {
      await apiRequest(`/api/server/worlds/${encodeURIComponent(world.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: renameWorldValue }),
      });
      setRenameWorldId(null);
      setRenameWorldValue('');
      pushPanelToast({ tone: 'success', title: 'Monde renommé', description: 'Le dossier et les données n’ont pas été déplacés.' });
      await refreshWorlds();
    } catch (error) {
      setWorldManagerError((error as Error).message);
    } finally {
      setWorldBusyId(null);
    }
  };

  const handleAssignWorld = async (world: ManagedWorld) => {
    const version = assignWorldVersion[world.id] ?? '';
    if (!version) {
      setWorldManagerError('Choisis la version BDS exacte de ce monde.');
      return;
    }
    setWorldBusyId(world.id);
    setWorldManagerError('');
    try {
      await apiRequest(`/api/server/worlds/${encodeURIComponent(world.id)}/assign`, {
        method: 'POST',
        body: JSON.stringify({ version }),
      });
      pushPanelToast({ tone: 'success', title: 'Version associée', description: `BDS ${version} est liée à ce monde et ne sera pas modifiée automatiquement.` });
      await refreshWorlds();
    } catch (error) {
      setWorldManagerError((error as Error).message);
    } finally {
      setWorldBusyId(null);
    }
  };

  const handleDeleteWorld = async (world: ManagedWorld): Promise<boolean> => {
    const typedName = await dialogs.prompt({
      title: `Supprimer « ${world.name} » ?`,
      message: 'La suppression définitive de ce monde effacera ses chunks. Cette action est irréversible. Pour éviter une suppression accidentelle, saisis son nom exact ci-dessous.',
      eyebrow: 'ACTION IRRÉVERSIBLE · MONDE BEDROCK',
      tone: 'danger',
      inputLabel: 'Nom exact du monde',
      placeholder: world.name,
      expectedValue: world.name,
      helperText: `Saisis exactement « ${world.name} » pour activer la suppression.`,
      confirmLabel: 'Supprimer définitivement',
      cancelLabel: 'Conserver le monde',
    });
    if (typedName === null) return false;
    if (typedName !== world.name) {
      setWorldManagerError('Suppression annulée : le nom saisi ne correspond pas exactement.');
      return false;
    }
    setWorldBusyId(world.id);
    setWorldManagerError('');
    try {
      await apiRequest(`/api/server/worlds/${encodeURIComponent(world.id)}`, {
        method: 'DELETE',
        body: JSON.stringify({ confirmName: typedName }),
      });
      if (selectedWorldId === world.id) {
        setSelectedWorldId(null);
        setWorldEditId(null);
      }
      pushPanelToast({ tone: 'success', title: 'Monde supprimé', description: `« ${world.name} » a été supprimé après confirmation du nom exact.` });
      await Promise.all([refreshWorlds(), refreshStatus(true)]);
      return true;
    } catch (error) {
      setWorldManagerError((error as Error).message);
      return false;
    } finally {
      setWorldBusyId(null);
    }
  };

  const handleImportWorld = async () => {
    if (!worldImportFile || !worldImportVersion) {
      setWorldManagerError('Choisis une archive .mcworld ou .zip et sa version BDS cible.');
      return;
    }
    const name = worldImportName.trim() || worldImportFile.name.replace(/\.(mcworld|zip)$/i, '');
    const query = new URLSearchParams({
      version: worldImportVersion,
      name,
      fileName: worldImportFile.name,
    });
    setWorldBusyId('import');
    setWorldManagerError('');
    try {
      const response = await fetch(`/api/server/worlds/import?${query.toString()}`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': worldImportFile.type || 'application/octet-stream' },
        body: worldImportFile,
      });
      const payload = await response.json().catch(() => ({})) as { world?: ManagedWorld; error?: string };
      if (!response.ok || !payload.world) throw new ApiError(payload.error || `Erreur HTTP ${response.status}.`, response.status);
      setWorldImportFile(null);
      setWorldImportName('');
      if (worldImportInputRef.current) worldImportInputRef.current.value = '';
      const nextWorlds = await refreshWorlds();
      const imported = nextWorlds.find((world) => world.id === payload.world!.id) ?? payload.world;
      pushPanelToast({ tone: 'success', title: 'Import terminé', description: `« ${imported.name} » a été ajouté sans remplacer aucun autre monde.` });
      if (imported.status === 'ready') chooseWorld(imported, false);
    } catch (error) {
      setWorldManagerError((error as Error).message);
    } finally {
      setWorldBusyId(null);
    }
  };

  const handleExportWorld = (world: ManagedWorld) => {
    const serverStatus = status?.state.server;
    const bedrockIsRunning = serverStatus?.status === 'running' || (serverStatus?.status === 'failed' && serverStatus.pid !== null);
    if (world.status !== 'ready' || bedrockIsRunning || isPipelineBusy) return;
    window.location.assign(`/api/server/worlds/${encodeURIComponent(world.id)}/export`);
  };

  const handlePlayitSetup = async () => {
    setBusyAction('playit');
    setNotice('');
    try {
      await apiRequest('/api/server/playit/setup', { method: 'POST', body: '{}' });
      setNotice('Le setup Playit est lancé. Le lien de claim apparaîtra ici dès qu’il sera prêt.');
      await refreshStatus();
    } catch (error) {
      setNotice((error as Error).message);
      await refreshStatus();
    } finally {
      setBusyAction(null);
    }
  };

  const handlePortwarpRetry = async () => {
    setBusyAction('portwarp');
    setNotice('');
    try {
      await apiRequest('/api/server/portwarp/retry', { method: 'POST', body: '{}' });
      setNotice('Vérification Portwarp relancée. Le code d’autorisation, s’il est nécessaire, apparaîtra ici sans être enregistré.');
      await refreshStatus();
    } catch (error) {
      setNotice((error as Error).message);
      await refreshStatus();
    } finally {
      setBusyAction(null);
    }
  };

  const updateChatbotSnapshot = (chatbot: ChatbotSnapshot) => {
    setStatus((current) => current ? { ...current, chatbot } : current);
  };

  const handleChatbotLink = async () => {
    const confirmed = await dialogs.confirm({
      title: 'Lier le compte Bedrock dédié ?',
      message: 'N-Craft va démarrer une connexion Bedrock avec un compte Microsoft dédié. Si un code appareil est demandé, tu l’approuveras toi-même sur le site Microsoft officiel. Le compte ne doit pas être opérateur et occupera un emplacement joueur. Aucun mot de passe ne sera demandé à N-Craft.',
      eyebrow: 'AUTORISATION MICROSOFT · ACTION EXPLICITE',
      tone: 'warning',
      confirmLabel: 'Continuer vers Microsoft',
      cancelLabel: 'Pas maintenant',
    });
    if (!confirmed) return;
    setChatbotBusy(true);
    setChatbotFeedback('');
    try {
      const result = await apiRequest<{ accepted: boolean; chatbot: ChatbotSnapshot }>('/api/server/chatbot/link', {
        method: 'POST',
        body: JSON.stringify({ confirm: 'I_CONFIRM_MICROSOFT_DEVICE_AUTH' }),
      });
      updateChatbotSnapshot(result.chatbot);
      setChatbotFeedback('Connexion lancée après confirmation. Aucun mot de passe n’est demandé à N-Craft.');
    } catch (error) {
      setChatbotFeedback((error as Error).message);
      await refreshStatus();
    } finally {
      setChatbotBusy(false);
    }
  };

  const handleChatbotCancel = async () => {
    setChatbotBusy(true);
    setChatbotFeedback('');
    try {
      const result = await apiRequest<{ cancelled: boolean; chatbot: ChatbotSnapshot }>('/api/server/chatbot/cancel', {
        method: 'POST',
        body: '{}',
      });
      updateChatbotSnapshot(result.chatbot);
      setChatbotFeedback('Flux Microsoft annulé.');
    } catch (error) {
      setChatbotFeedback((error as Error).message);
    } finally {
      setChatbotBusy(false);
    }
  };

  const handleChatbotUnlink = async () => {
    const confirmation = await dialogs.prompt({
      title: 'Délier le compte dédié ?',
      message: 'Le profil Bedrock sera délié et son cache OAuth privé supprimé définitivement de DATA_DIR. Cette action ne peut pas être annulée.',
      eyebrow: 'ACTION IRRÉVERSIBLE · COMPTE BEDROCK',
      tone: 'danger',
      inputLabel: 'Saisis SUPPRIMER pour confirmer',
      placeholder: 'SUPPRIMER',
      expectedValue: 'SUPPRIMER',
      helperText: 'Le mot doit correspondre exactement, en majuscules.',
      confirmLabel: 'Délier et supprimer',
      cancelLabel: 'Annuler',
    });
    if (confirmation !== 'SUPPRIMER') {
      setChatbotFeedback('Suppression annulée.');
      return;
    }
    setChatbotBusy(true);
    setChatbotFeedback('');
    try {
      const result = await apiRequest<{ unlinked: boolean; chatbot: ChatbotSnapshot }>('/api/server/chatbot/account', {
        method: 'DELETE',
        body: JSON.stringify({ confirm: 'UNLINK_BEDROCK_CHATBOT_ACCOUNT' }),
      });
      updateChatbotSnapshot(result.chatbot);
      setChatbotFeedback('Profil Bedrock et jetons OAuth supprimés.');
      pushPanelToast({ tone: 'success', title: 'Compte délié', description: 'Le profil Bedrock et son cache OAuth privé ont été supprimés.' });
    } catch (error) {
      setChatbotFeedback((error as Error).message);
    } finally {
      setChatbotBusy(false);
    }
  };

  const handleStart = async () => {
    setBusyAction('start');
    setNotice('');
    setFormError('');
    try {
      await apiRequest('/api/server/start', { method: 'POST', body: '{}' });
      setNotice('Démarrage accepté. Le monde existant est conservé ; suis l’état et les logs dans le dashboard.');
      await refreshStatus();
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusyAction(null);
    }
  };

  const handleStop = async () => {
    const confirmed = await dialogs.confirm({
      title: 'Arrêter le serveur Bedrock ?',
      message: `Seul bedrock_server sera arrêté. Le tunnel ${tunnelProvider} restera en fonctionnement et le monde sera conservé.`,
      eyebrow: 'ARRÊT GRACIEUX · BEDROCK',
      tone: 'warning',
      confirmLabel: 'Arrêter Bedrock',
      cancelLabel: 'Garder le serveur en ligne',
    });
    if (!confirmed) return;
    setBusyAction('stop');
    setNotice('');
    try {
      await apiRequest('/api/server/stop', { method: 'POST', body: '{}' });
      await refreshStatus();
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusyAction(null);
    }
  };

  const handleCommand = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = command.trim();
    const socket = socketRef.current;
    if (!value) return;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setConsoleError('Console WebSocket déconnectée.');
      return;
    }
    socket.send(JSON.stringify({ type: 'command', command: value }));
    setCommand('');
    setConsoleError('');
  };

  const addAdminField = () => {
    if (configuration.adminXuids.length >= 3) return;
    changeField('adminXuids', [...configuration.adminXuids, '']);
  };

  const setAdminXuid = (index: number, value: string) => {
    const next = [...configuration.adminXuids];
    next[index] = value;
    changeField('adminXuids', next);
  };

  const removeAdminField = (index: number) => {
    if (configuration.adminXuids.length <= 1) return;
    changeField('adminXuids', configuration.adminXuids.filter((_value, currentIndex) => currentIndex !== index));
  };

  const handleCopy = async (value: string, label: string) => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(value);
      setNotice(`${label} copié.`);
      setFormError('');
    } catch {
      setNotice(`Copie automatique indisponible. Sélectionne ${label.toLowerCase()} puis copie-le manuellement.`);
    }
  };

  if (authLoading) {
    return (
      <main className="ncraft-shell ncraft-auth-shell">
        <NetherAmbientBackground />
        <div className="ncraft-auth-orbit" aria-hidden="true" />
        <motion.div
          className="ncraft-loading-card"
          initial={reduceMotion ? false : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <span className="brand-mark"><NebulaBrandMark /></span>
          <Loader2 className="spin-soft" size={18} />
          <span>Chargement du panneau…</span>
        </motion.div>
      </main>
    );
  }

  if (!authenticated) {
    return (
      <main className="ncraft-shell ncraft-auth-shell">
        <NetherAmbientBackground />
        <div className="ncraft-auth-orbit" aria-hidden="true" />
        <motion.div
          className="ncraft-login-layout"
          initial={reduceMotion ? false : { opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.42, ease: [0.22, 1, 0.36, 1] }}
        >
          <aside className="ncraft-login-showcase">
            <div className="login-showcase__texture" aria-hidden="true" />
            <div className="login-showcase__brand" aria-hidden="true">
              <span className="brand-mark"><NebulaBrandMark /></span>
              <span>BEDROCK CONTROL DECK</span>
            </div>
            <div className="login-showcase__portal" aria-hidden="true"><span /><span /><span /></div>
            <img
              className="login-showcase__mascot"
              src="/assets/minecraft/creeper-mascot.svg"
              alt="Creeper pixelisé, mascotte de N-Craft"
              width="140"
              height="204"
            />
            <div className="login-showcase__content">
              <p className="login-showcase__eyebrow">CONSOLE OPÉRATEUR · MINECRAFT BEDROCK</p>
              <p className="login-showcase__title">Garde la main<br /><span>sur ton monde.</span></p>
              <p className="login-showcase__description">Déploie Bedrock, retrouve tes sauvegardes et surveille ton serveur depuis un seul panneau privé.</p>
            </div>
            <div className="login-showcase__footer" aria-hidden="true">
              <span><LockKeyhole size={14} /> Accès privé</span>
              <span><ShieldCheck size={14} /> Jeton non conservé</span>
            </div>
          </aside>

          <motion.section
            className="ncraft-login-card"
            initial={reduceMotion ? false : { opacity: 0, y: 10, scale: 0.99 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: reduceMotion ? 0 : 0.3, delay: reduceMotion ? 0 : 0.06, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="login-brand-row">
              <span className="brand-mark brand-mark--large"><NebulaBrandMark /></span>
              <div>
                <p className="nether-eyebrow">BEDROCK CONTROL DECK</p>
                <h1 className="login-wordmark">Nebula Craft</h1>
                <p className="login-subtitle">Panneau privé · instance Bedrock</p>
              </div>
            </div>
            <div className="login-divider" />
            <div className="login-heading">
              <span className="login-heading__icon"><LockKeyhole size={18} /></span>
              <div>
                <h2>Accès opérateur</h2>
                <p>Connecte-toi pour gérer ton serveur.</p>
              </div>
            </div>
            <p className="login-security-copy">
              Le jeton est échangé contre un cookie de session HttpOnly. Il n’est pas conservé dans le navigateur.
            </p>
            {!authStatus?.configured && (
              <div role="alert" className="nether-callout nether-callout--danger">
                <AlertTriangle size={17} />
                <span>PANEL_TOKEN n’est pas configuré dans l’environnement du conteneur. Définis-le, puis redémarre le panneau.</span>
              </div>
            )}
            <form onSubmit={handleLogin} className="login-form">
              <div className="nether-field">
                <label className="login-token-label" htmlFor="panel-token">Jeton du panneau</label>
                <div className="login-token-field">
                  <input
                    id="panel-token"
                    type={showToken ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    disabled={!authStatus?.configured || loginBusy}
                    className="nether-input login-token-input"
                    placeholder="Saisis le jeton du panneau"
                    aria-invalid={Boolean(loginError)}
                    aria-describedby={loginError ? 'login-error' : undefined}
                  />
                  <button
                    type="button"
                    className="login-token-toggle"
                    onClick={() => setShowToken((visible) => !visible)}
                    disabled={!authStatus?.configured || loginBusy}
                    aria-label={showToken ? 'Masquer le jeton' : 'Afficher le jeton'}
                    aria-pressed={showToken}
                    title={showToken ? 'Masquer le jeton' : 'Afficher le jeton'}
                  >
                    {showToken ? <EyeOff size={17} /> : <Eye size={17} />}
                  </button>
                </div>
              </div>
              {loginError && <p id="login-error" role="alert" className="inline-error">{loginError}</p>}
              <motion.button
                type="submit"
                disabled={!authStatus?.configured || loginBusy || !token}
                whileTap={reduceMotion ? undefined : { scale: 0.985 }}
                className="nether-btn nether-btn--primary nether-btn--wide"
              >
                {loginBusy ? <Loader2 className="spin-soft" size={17} /> : <ArrowRight size={17} />}
                {loginBusy ? 'Vérification…' : 'Ouvrir le panneau'}
              </motion.button>
            </form>
            <p className="login-footer"><ShieldCheck size={14} /> Session HttpOnly · jeton non conservé</p>
          </motion.section>
        </motion.div>
      </main>
    );
  }

  const server = status?.state.server;
  const tunnelProvider = status?.tunnelProvider ?? 'portwarp';
  const playit = status?.state.playit;
  const localtonet = status?.state.localtonet;
  const portwarp = status?.state.portwarp;
  const activeTunnel = tunnelProvider === 'portwarp'
    ? portwarp
    : tunnelProvider === 'localtonet' ? localtonet : playit;
  const playitSetup = status?.playitSetup;
  const portwarpSetup = status?.portwarpSetup;
  const system = status?.system;
  const pipeline = status?.state.pipeline;
  const scheduler = status?.scheduler;
  const activeConfig = status?.state.activeConfig;
  const activeWorld = activeConfig
    ? worlds.find((world) => world.version === activeConfig.version && world.folder === activeConfig.levelName)
    : undefined;
  const selectedWorld = selectedWorldId ? worlds.find((world) => world.id === selectedWorldId) : undefined;
  const editingWorld = worldEditId ? worlds.find((world) => world.id === worldEditId) : undefined;
  const selectedVersion = versions.find((version) => version.version === configuration.version);
  const isExistingDeployment = Boolean(activeConfig);
  const configurationLocked = isPipelineBusy || !server
    || server.status === 'running'
    || server.status === 'starting'
    || server.status === 'stopping'
    || (server.status === 'failed' && server.pid !== null);
  const worldsForSelectedVersion = worlds.filter((world) => world.version === configuration.version && world.status === 'ready');
  const hasVersionChange = Boolean(activeConfig && configuration.version !== activeConfig.version);
  const hasWorldChange = selectedWorldId
    ? selectedWorld?.id !== activeWorld?.id
    : true;
  const isEditingWorldSettings = Boolean(editingWorld && selectedWorldId === editingWorld.id);
  const hasSettingsChanges = Boolean(activeConfig && hasConfigurationSettingsChanged(activeConfig, configuration));
  const hasEditedWorldSettings = Boolean(editingWorld?.configuration
    ? hasConfigurationSettingsChanged(editingWorld.configuration, {
      ...configuration,
      version: editingWorld.version ?? configuration.version,
      levelName: editingWorld.folder,
      seed: editingWorld.seed ?? '',
    })
    : isEditingWorldSettings);
  const operationNeedsDeploy = !isExistingDeployment || hasVersionChange || hasWorldChange;
  const invalidWorldTarget = selectedWorldId
    ? !selectedWorld || selectedWorld.status !== 'ready' || selectedWorld.version !== configuration.version
    : !newWorldName.trim();
  const configurationActionDisabled = configurationLocked
    || !isValidForm(configuration)
    || (isEditingWorldSettings
      ? !editingWorld?.version || !hasEditedWorldSettings
      : operationNeedsDeploy
        ? !selectedVersion || invalidWorldTarget || system?.deployReady === false
        : !hasSettingsChanges);
  const configurationActionLabel = busyAction === 'save-config' || (worldBusyId && isEditingWorldSettings)
    ? 'Enregistrement…'
    : isPipelineBusy
      ? busyAction === 'deploy' ? `Déploiement : ${statusLabel(pipeline?.step ?? 'preflight')}` : 'Opération en cours…'
      : !server
        ? 'Vérification du serveur…'
        : server.status === 'running' || (server.status === 'failed' && server.pid !== null)
          ? 'Arrête Bedrock pour modifier'
          : server.status === 'starting' || server.status === 'stopping'
            ? 'Bedrock en transition…'
            : isEditingWorldSettings
              ? 'Enregistrer les options du monde'
              : !isExistingDeployment
                ? 'Installer & démarrer le monde'
                : hasVersionChange
                  ? 'Mettre à jour & démarrer'
                  : hasWorldChange
                    ? selectedWorld ? 'Reprendre ce monde & démarrer' : 'Créer & démarrer le monde'
                    : hasSettingsChanges ? 'Enregistrer les réglages' : 'Aucun changement';
  const providerName = tunnelProvider === 'portwarp' ? 'Portwarp' : tunnelProvider === 'localtonet' ? 'Localtonet' : 'Playit';
  const versionEntry = activeConfig?.version
    ? versions.find((version) => version.version === activeConfig.version)
    : undefined;
  const currentServerStatus = server?.status ?? 'stopped';
  const tunnelStatus = activeTunnel?.status ?? 'starting';
  const bedrockMayBeRunning = server?.status === 'running' || (server?.status === 'failed' && server.pid !== null);
  const startDisabled = isPipelineBusy || !activeConfig || !system?.bedrockBinary.ok || bedrockMayBeRunning || busyAction === 'stop';
  const stopDisabled = isPipelineBusy || busyAction === 'stop' || !bedrockMayBeRunning;
  const chatbot = status?.chatbot;
  const chatbotPillStatus = chatbot?.status === 'online' ? 'running'
    : chatbot?.status === 'failed' ? 'failed'
      : chatbot?.status === 'awaiting_approval' || chatbot?.status === 'connecting' ? 'starting' : 'stopped';
  const chatbotPillLabel = !chatbot?.protocolSupported ? 'BUILD NON VALIDÉ'
    : chatbot?.status === 'online' ? 'ACTIF'
      : chatbot?.status === 'awaiting_approval' ? 'CODE À APPROUVER'
        : chatbot?.status === 'connecting' ? 'CONNEXION'
          : chatbot?.status === 'failed' ? 'ERREUR' : 'INACTIF';

  return (
    <main className="ncraft-shell">
      <a className="skip-link" href="#main-content">Aller au contenu principal</a>
      <div className="ncraft-ambient ncraft-ambient--magma" aria-hidden="true" />
      <div className="ncraft-ambient ncraft-ambient--portal" aria-hidden="true" />
      <div className="ncraft-grid-glow" aria-hidden="true" />
      <NetherAmbientBackground />

      <header className="ncraft-header">
        <div className="ncraft-header__inner">
          <a className="ncraft-brand" href="#overview" aria-label="Nebula Craft, accueil" onClick={(event) => { event.preventDefault(); switchPanel('overview'); }}>
            <motion.span className="brand-mark" whileHover={reduceMotion ? undefined : { rotate: 8, scale: 1.04 }}>
              <NebulaBrandMark />
            </motion.span>
            <span className="ncraft-brand__copy">
              <strong className="ncraft-brand__name">Nebula Craft</strong>
              <small>BEDROCK CONTROL DECK</small>
            </span>
          </a>

          <div className="ncraft-nav-shell" ref={navMenuRef}>
            <button
              ref={navMenuButtonRef}
              type="button"
              className="ncraft-nav-trigger"
              aria-label={`Ouvrir la navigation · ${PANEL_TABS.find((tab) => tab.id === activeSection)?.label ?? 'Panneau'}`}
              aria-haspopup="true"
              aria-expanded={navMenuOpen}
              aria-controls="ncraft-branched-navigation"
              onClick={() => setNavMenuOpen((open) => !open)}
            >
              <Layers size={16} aria-hidden="true" />
              <span><small>SECTIONS</small><strong>{PANEL_TABS.find((tab) => tab.id === activeSection)?.label ?? 'Panneau'}</strong></span>
              <ChevronRight className={navMenuOpen ? 'is-open' : undefined} size={15} aria-hidden="true" />
            </button>
            <AnimatePresence initial={false}>
              {navMenuOpen && (
                <motion.div
                  key="branched-navigation"
                  id="ncraft-branched-navigation"
                  className="ncraft-nav-popover"
                  initial={reduceMotion ? false : { opacity: 0, y: -6, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={reduceMotion ? undefined : { opacity: 0, y: -5, scale: 0.98 }}
                  transition={reduceMotion ? { duration: 0 } : { duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
                >
                  <p className="ncraft-nav-popover__eyebrow">NAVIGATION DU PANNEAU</p>
                  <BranchedMenu
                    items={BRANCHED_NAV_ITEMS}
                    active={activeSection}
                    ariaLabel="Navigation du panneau"
                    defaultOpen={0}
                    onSelect={(value) => {
                      switchPanel(value as PanelTabId);
                      navMenuButtonRef.current?.focus({ preventScroll: true });
                    }}
                    width={260}
                    rowHeight={34}
                    indent={28}
                    trunk={11}
                    radius={7}
                    fontSize={12}
                    color="var(--nether-text)"
                    accentColor="var(--nether-magma)"
                    lineColor="rgba(234, 214, 245, 0.2)"
                    className="ncraft-branched-menu"
                  />
                  <span className="sr-only">Appuie sur Échap pour fermer ce menu.</span>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <div className="ncraft-header__actions">
            <StatusPill status={currentServerStatus} />
            <motion.button
              type="button"
              onClick={() => setAboutOpen(true)}
              whileTap={reduceMotion ? undefined : { scale: 0.95 }}
              className="icon-button about-trigger"
              aria-label="À propos de Nebula Craft"
              title="À propos de Nebula Craft"
            >
              <Info size={17} aria-hidden="true" />
              <span>À propos</span>
            </motion.button>
            <motion.button
              type="button"
              onClick={() => void handleLogout()}
              disabled={busyAction === 'logout'}
              whileTap={reduceMotion ? undefined : { scale: 0.95 }}
              className="icon-button logout-button"
              aria-label="Déconnexion"
              title="Déconnexion"
            >
              {busyAction === 'logout' ? <Loader2 className="spin-soft" size={17} /> : <LogOut size={17} />}
              <span>Quitter</span>
            </motion.button>
          </div>
        </div>
      </header>

      <div id="main-content" tabIndex={-1} className="ncraft-main">
        <AnimatePresence initial={false}>
          {(notice || formError) && (
            <motion.div
              key={formError ? 'error' : 'notice'}
              role={formError ? 'alert' : 'status'}
              aria-live={formError ? 'assertive' : 'polite'}
              className={`nether-banner ${formError ? 'nether-banner--danger' : 'nether-banner--success'}`}
              initial={reduceMotion ? false : { opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? undefined : { opacity: 0, y: -8 }}
            >
              {formError ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />}
              <span>{formError || notice}</span>
              <button type="button" onClick={() => { setNotice(''); setFormError(''); }} aria-label="Fermer le message"><X size={17} /></button>
            </motion.div>
          )}
        </AnimatePresence>

        <section
          id="panel-overview"
          className="ncraft-tab-panel"
          role="tabpanel"
          aria-label="Vue générale"
          tabIndex={0}
          hidden={activeSection !== 'overview'}
        >
          {activeSection === 'overview' && (
            <motion.div
              className="ncraft-tab-panel__content"
              initial={reduceMotion || !animatePanelEntry ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={reduceMotion ? { duration: 0 } : { duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            >
          <section className="ncraft-overview-grid">
            <motion.section
              className="nether-hero"
              initial={reduceMotion ? false : { opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.48, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="nether-hero__ambient" aria-hidden="true"><span /><span /><span /></div>
              <div className="nether-hero__topline">
                <span className="nether-hero__mark"><Server size={17} /></span>
                <span className="nether-eyebrow">CONTRÔLE DU SERVEUR</span>
                <StatusPill status={currentServerStatus} />
              </div>
              <div className="nether-hero__intro">
                <h1>Ton monde,<br /><span>sous contrôle.</span></h1>
                <p>Bedrock Dedicated Server · Instance unique</p>
              </div>

              <div className="world-capsule">
                <span className={`world-capsule__icon ${activeConfig ? 'world-capsule__icon--block' : ''}`} aria-hidden="true">
                  {activeConfig ? (
                    <RefineFrame
                      status={isPipelineBusy ? 'refining' : 'complete'}
                      width={34}
                      aspectRatio="1"
                      radius={10}
                      background="rgba(20, 31, 24, 0.9)"
                      color="var(--nether-moss)"
                      labels={{ queued: 'En attente', generating: 'Préparation', refining: 'Déploiement', complete: 'Prêt', error: 'Échec' }}
                      stageDuration={520}
                      sweep={isPipelineBusy}
                      showStatus={false}
                      className="ncraft-world-frame"
                    >
                      <img src="/assets/minecraft/grass-block.webp" alt="" width="34" height="34" />
                    </RefineFrame>
                  ) : <Globe size={19} />}
                </span>
                <span className="world-capsule__copy">
                  <small>MONDE ACTIF</small>
                  <strong title={activeWorld?.name ?? activeConfig?.levelName ?? 'Aucun monde déployé'}>{activeWorld?.name ?? activeConfig?.levelName ?? 'Aucun monde déployé'}</strong>
                </span>
                <span className="world-capsule__version">
                  {activeConfig?.version ? `BDS ${activeConfig.version}` : 'À configurer'}
                </span>
              </div>

              <div className="hero-metrics-grid">
                <MetricTile icon={Users} label="Joueurs" value={`${server?.playersOnline ?? '—'} / ${activeConfig?.maxPlayers ?? '—'}`} detail="connectés / maximum" accent="portal" />
                <MetricTile icon={Clock3} label="Disponibilité" value={<LiveUptime startedAt={server?.status === 'running' ? server.startedAt : null} />} detail={server?.status === 'running' && server.startedAt ? 'depuis le démarrage' : 'serveur hors ligne'} accent="soul" />
              </div>

              <div className="nether-hero__actions">
                <motion.button
                  type="button"
                  onClick={() => void handleStart()}
                  disabled={startDisabled}
                  whileTap={reduceMotion ? undefined : { scale: 0.97 }}
                  className="nether-btn nether-btn--primary"
                >
                  {busyAction === 'start' ? <Loader2 className="spin-soft" size={17} /> : <Play size={17} fill="currentColor" />}
                  {busyAction === 'start' ? 'Démarrage…' : 'Démarrer Bedrock'}
                </motion.button>
                <motion.button
                  type="button"
                  onClick={() => void handleStop()}
                  disabled={stopDisabled}
                  whileTap={reduceMotion ? undefined : { scale: 0.97 }}
                  className="nether-btn nether-btn--danger"
                >
                  {busyAction === 'stop' ? <Loader2 className="spin-soft" size={17} /> : <Power size={17} />}
                  {busyAction === 'stop' ? 'Arrêt…' : 'Arrêter'}
                </motion.button>
                <motion.button type="button" className="nether-btn nether-btn--quiet" onClick={() => switchPanel('deploy')} whileTap={reduceMotion ? undefined : { scale: 0.97 }}><Package size={16} /> Mettre à jour <ArrowRight size={14} /></motion.button>
              </div>

              <div className="restart-strip">
                <span className="restart-strip__icon"><Clock3 size={15} /></span>
                <span className="restart-strip__label">Redémarrage quotidien</span>
                <strong>{scheduler?.enabled ? `${scheduler.time} · ${scheduler.timeZone}` : 'Désactivé'}</strong>
                {scheduler?.enabled && <span className="restart-strip__next">Prochain : {formatScheduledTime(scheduler.nextRestartAt, scheduler.timeZone)}</span>}
                {scheduler?.phase === 'countdown' && <span className="restart-strip__notice">Annonce · {formatDuration(scheduler.countdownSeconds)}</span>}
                {scheduler?.phase === 'restarting' && <span className="restart-strip__notice">Redémarrage en cours…</span>}
                {scheduler?.phase === 'failed' && <span className="restart-strip__error">{scheduler.error || 'Échec du redémarrage automatique.'}</span>}
              </div>
              {server?.error && <p className="hero-error"><AlertTriangle size={15} />{server.error}</p>}
            </motion.section>

            <NetherCard
              id="network"
              title={`Relais ${providerName}`}
              eyebrow="ACCÈS BEDROCK · UDP 19132"
              description="Adresse publique du tunnel sélectionné"
              icon={Wifi}
              accent="soul"
              className="tunnel-card"
              action={<StatusPill status={tunnelStatus} />}
            >
              <div className="public-address-panel">
                <div className="public-address-panel__heading"><span>ADRESSE PUBLIQUE</span><Globe size={15} /></div>
                {activeTunnel?.address ? (
                  <div className="public-address-value">
                    <code>{activeTunnel.address}</code>
                    <motion.button
                      type="button"
                      onClick={() => void handleCopy(activeTunnel.address ?? '', 'Adresse')}
                      whileTap={reduceMotion ? undefined : { scale: 0.92 }}
                      className="copy-button"
                      aria-label="Copier l’adresse publique"
                      title="Copier l’adresse"
                    ><Copy size={15} /></motion.button>
                  </div>
                ) : (
                  <p className="public-address-empty">L’adresse apparaîtra lorsque le relais sera connecté.</p>
                )}
              </div>
              <div className="tunnel-meta-row">
                <span>Destination locale</span>
                <code>127.0.0.1:19132/UDP</code>
              </div>

              {tunnelProvider === 'portwarp' && portwarp && (
                <div className="tunnel-detail-stack">
                  <div className="tunnel-meta-row">
                    <span>{portwarp.tunnelName}</span>
                    <code>UDP {portwarp.localPort ?? 19132}{portwarp.publicPort ? ` → ${portwarp.publicPort}` : ''}</code>
                  </div>
                  <AnimatePresence initial={false}>
                    {portwarpSetup?.phase === 'waiting_for_approval' && portwarpSetup.userCode && (
                      <motion.div
                        key="portwarp-approval"
                        className="nether-callout nether-callout--portal"
                        initial={reduceMotion ? false : { opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={reduceMotion ? undefined : { opacity: 0, height: 0 }}
                      >
                        <LockKeyhole size={17} />
                        <div className="callout-copy">
                          <strong>Autorise cette machine</strong>
                          <span>Ouvre Portwarp avec ta session authentifiée, puis saisis ce code temporaire :</span>
                          <a href={portwarpSetup.verificationUrl ?? 'https://portwarp.com/device'} target="_blank" rel="noreferrer" className="inline-link">
                            Ouvrir portwarp.com/device <ExternalLink size={13} />
                          </a>
                          <div className="device-code-row">
                            <code>{portwarpSetup.userCode}</code>
                            <button type="button" onClick={() => void handleCopy(portwarpSetup.userCode ?? '', 'Code temporaire')} className="copy-button copy-button--small" aria-label="Copier le code temporaire"><Copy size={14} /></button>
                          </div>
                          <small>Éphémère : affiché dans cette session authentifiée, jamais enregistré dans .env ou l’état du panel.</small>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                  {portwarpSetup?.phase === 'starting' && <p className="nether-inline-note"><Loader2 size={14} className="spin-soft" /> Démarrage de l’autorisation Portwarp…</p>}
                  {portwarpSetup?.phase === 'failed' && portwarpSetup.error && <p role="alert" className="inline-error">{portwarpSetup.error}</p>}
                  {portwarp.status === 'tunnel_missing' && (
                    <div className="nether-callout nether-callout--warning">
                      <AlertTriangle size={17} />
                      <div className="callout-copy">
                        <strong>Tunnel existant introuvable</strong>
                        <span>Crée ou active manuellement « {portwarp.tunnelName} » dans Portwarp : UDP vers 127.0.0.1:19132. N-Craft ne crée ni ne supprime de tunnel.</span>
                        <a href="https://portwarp.com/tunnels" target="_blank" rel="noreferrer" className="inline-link">Gérer mes tunnels <ExternalLink size={13} /></a>
                      </div>
                    </div>
                  )}
                  {portwarp.status === 'client_missing' && <p className="nether-callout nether-callout--warning"><AlertTriangle size={17} />Le CLI pwrp manque. Relance ncraft setup pour l’installer et le vérifier.</p>}
                  {portwarp.error && <p role="status" className="inline-error">{portwarp.error}</p>}
                </div>
              )}

              {tunnelProvider === 'localtonet' && localtonet?.status === 'address_not_detected' && (
                <p className="nether-callout nether-callout--warning"><AlertTriangle size={17} />Crée et démarre dans Localtonet un tunnel UDP vers 127.0.0.1:19132. Son adresse apparaîtra ici.</p>
              )}
              {tunnelProvider === 'localtonet' && localtonet?.status === 'configuration_missing' && (
                <p className="nether-callout nether-callout--warning"><AlertTriangle size={17} />Vérifie le client Localtonet et configure LOCALTONET_AUTH_TOKEN ainsi que LOCALTONET_API_KEY dans le .env du conteneur, puis redémarre le panneau.</p>
              )}
              {tunnelProvider === 'localtonet' && localtonet?.error && <p role="status" className="inline-error">{localtonet.error}</p>}
              {tunnelProvider === 'playit' && playitSetup?.claimUrl && (
                <a href={playitSetup.claimUrl} target="_blank" rel="noreferrer" className="nether-btn nether-btn--primary nether-btn--wide"><ExternalLink size={16} /> Ouvrir le lien Playit</a>
              )}
              {tunnelProvider === 'playit' && playitSetup?.phase === 'configured' && !playit?.address && <p className="nether-inline-note">Agent approuvé. Crée un tunnel Bedrock UDP dans ton compte Playit.</p>}
              {tunnelProvider === 'playit' && (playitSetup?.phase === 'waiting_for_secret' || playitSetup?.phase === 'starting') && !playitSetup.claimUrl && <p className="nether-inline-note"><Loader2 size={14} className="spin-soft" /> Préparation du lien de claim…</p>}
              {tunnelProvider === 'playit' && playitSetup?.error && <p role="status" className="inline-error">{playitSetup.error}</p>}
              {tunnelProvider === 'playit' && playit?.error && <p role="status" className="inline-error">{playit.error}</p>}
              {tunnelProvider === 'playit' && (playitSetup?.phase === 'failed' || (playitSetup?.phase === 'waiting_for_secret' && !playitSetup.claimUrl)) && (
                <motion.button type="button" onClick={() => void handlePlayitSetup()} disabled={busyAction === 'playit'} whileTap={reduceMotion ? undefined : { scale: 0.97 }} className="nether-btn nether-btn--quiet nether-btn--wide">
                  {busyAction === 'playit' ? <Loader2 className="spin-soft" size={16} /> : <RefreshCw size={16} />}
                  {busyAction === 'playit' ? 'Démarrage…' : 'Réessayer le claim'}
                </motion.button>
              )}

              {tunnelProvider === 'portwarp' && (
                <motion.button
                  type="button"
                  onClick={() => void handlePortwarpRetry()}
                  disabled={busyAction === 'portwarp'}
                  whileTap={reduceMotion ? undefined : { scale: 0.97 }}
                  className="nether-btn nether-btn--quiet nether-btn--wide"
                >
                  {busyAction === 'portwarp' ? <Loader2 className="spin-soft" size={16} /> : <RefreshCw size={16} />}
                  {busyAction === 'portwarp' ? 'Vérification…' : 'Vérifier / reconnecter'}
                </motion.button>
              )}
              <p className="tunnel-caveat">Un relais actif ne prouve pas que Bedrock UDP est joignable depuis Internet. Vérifie l’adresse depuis un client Bedrock.</p>
            </NetherCard>
          </section>

          <section className="ncraft-telemetry-grid" aria-label="Mesures et configuration Bedrock">
            <BedrockMetricsChart samples={metricHistory} serverStatus={server?.status} />
            <NetherCard title="Fiche du monde" eyebrow="CONFIGURATION ACTIVE" icon={Database} accent="moss">
              {activeConfig ? (
                <dl className="world-details-list">
                  <WorldDetail label="Nom du serveur" value={activeConfig.serverName} />
                  <WorldDetail label="Version Bedrock" value={versionEntry?.label ?? activeConfig.version} />
                  <WorldDetail label="Mode de jeu" value={activeConfig.gamemode === 'survival' ? 'Survie' : activeConfig.gamemode === 'creative' ? 'Créatif' : 'Aventure'} />
                  <WorldDetail label="Difficulté" value={activeConfig.difficulty === 'peaceful' ? 'Paisible' : activeConfig.difficulty === 'easy' ? 'Facile' : activeConfig.difficulty === 'normal' ? 'Normale' : 'Difficile'} />
                  <WorldDetail label="Joueurs maximum" value={String(activeConfig.maxPlayers)} />
                  <WorldDetail label="Distance de vue" value={`${activeConfig.viewDistance} chunks`} />
                </dl>
              ) : (
                <div className="empty-state"><Package size={24} /><strong>Aucune version déployée</strong><span>Choisis une version Bedrock vérifiée dans le panneau de déploiement.</span><button type="button" className="empty-state__link" onClick={() => switchPanel('deploy')}>Configurer le serveur <ChevronRight size={14} /></button></div>
              )}
            </NetherCard>
          </section>
            </motion.div>
          )}
        </section>

        <section
          id="panel-deploy"
          className="ncraft-tab-panel"
          role="tabpanel"
          aria-label="Déploiement"
          tabIndex={0}
          hidden={activeSection !== 'deploy'}
        >
          {activeSection === 'deploy' && (
            <motion.div
              className="ncraft-tab-panel__content"
              initial={reduceMotion || !animatePanelEntry ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={reduceMotion ? { duration: 0 } : { duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            >
          <PanelHeading
            variant="deployment"
            eyebrow="DÉPLOIEMENT BEDROCK"
            title="Déployer Bedrock"
            description="Choisis une build BDS et sa sauvegarde. Enregistrer les propriétés laisse Bedrock arrêté; changer de version ou de monde lance le déploiement et son redémarrage."
          />
          <section className="ncraft-workspace-grid ncraft-workspace-grid--single">
            <NetherCard
              title="Déployer un monde"
              eyebrow="VERSION ET RÉGLAGES BEDROCK"
              description="Les propriétés peuvent être enregistrées sans redémarrer. Changer de version ou de monde lance un déploiement puis redémarre Bedrock."
              icon={Package}
              accent="magma"
              className="deploy-card"
            >
              <form onSubmit={handleDeploy} className="deploy-form">
                {isExistingDeployment && (
                  <div className="nether-callout nether-callout--success">
                    <ShieldCheck size={18} />
                    <div className="callout-copy">
                      <strong>Mise à jour non destructive</strong>
                      <span>Le monde, les packs, les permissions et les fichiers non modifiés sont conservés. Les réglages peuvent être enregistrés lorsque Bedrock est arrêté.</span>
                    </div>
                  </div>
                )}
                {isExistingDeployment && bedrockMayBeRunning && (
                  <div className="nether-callout nether-callout--warning">
                    <LockKeyhole size={18} />
                    <div className="callout-copy">
                      <strong>Bedrock doit être arrêté</strong>
                      <span>Arrête Bedrock pour modifier les réglages ou la version. Le tunnel restera actif.</span>
                    </div>
                  </div>
                )}
                {isExistingDeployment && !configurationLocked && (
                  <p className="nether-inline-note"><ShieldCheck size={15} />Enregistrer les réglages ne télécharge pas Bedrock et ne démarre pas le serveur. Il restera arrêté jusqu’à ce que tu cliques sur « Démarrer Bedrock ».</p>
                )}

                <div className="cartridge-slot">
                  <div className="cartridge-slot__art"><Package size={26} /></div>
                  <div className="nether-field cartridge-slot__picker">
                    <span id="bedrock-version-label">Version du serveur <b>requise</b></span>
                    <GlideSelect
                      options={versions.map((version): GlideSelectOption => ({
                        value: version.version,
                        label: version.label,
                        tag: version.releaseDate ?? `Client ${version.clientVersion}`,
                      }))}
                      value={configuration.version}
                      onChange={(value) => changeField('version', value)}
                      labelledBy="bedrock-version-label"
                      describedBy="bedrock-version-status"
                      disabled={configurationLocked}
                      required
                      invalid={!selectedVersion}
                    />
                  </div>
                  <div id="bedrock-version-status" className="cartridge-slot__info">
                    <span className="nether-eyebrow">SÉLECTION</span>
                    <strong>{selectedVersion?.label ?? (configuration.version || 'Aucune version')}</strong>
                    <small className={!selectedVersion && versions.length > 0 ? 'cartridge-slot__version-error' : undefined}>
                      {selectedVersion
                        ? `${selectedVersion.channel === 'preview' ? 'Preview' : 'Version stable'} · client ${selectedVersion.clientVersion}${selectedVersion.releaseDate ? ` · sortie ${selectedVersion.releaseDate}` : ''}`
                        : versions.length > 0 ? 'Version indisponible · choisis une version du catalogue' : 'Catalogue historique du panneau'}
                    </small>
                  </div>
                </div>
                {versions.length === 0 && <p className="inline-error">Aucune archive BDS configurée dans le catalogue local.</p>}

                <fieldset className="world-choice-box" disabled={configurationLocked}>
                  <legend>Monde à démarrer <b>requis</b></legend>
                  <div className="world-choice-grid" role="radiogroup" aria-label="Monde à démarrer">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={!selectedWorldId}
                      className={`world-choice-card ${!selectedWorldId ? 'is-selected' : ''}`}
                      onClick={chooseNewWorld}
                      disabled={configurationLocked}
                    >
                      <span className="world-choice-card__radio" aria-hidden="true" />
                      <span className="world-choice-card__copy"><strong>Créer un nouveau monde</strong><small>Nouveau dossier isolé pour BDS {configuration.version || 'sélectionné'}</small></span>
                      <Globe size={17} />
                    </button>
                    {worldsForSelectedVersion.map((world) => (
                      <button
                        key={world.id}
                        type="button"
                        role="radio"
                        aria-checked={selectedWorldId === world.id}
                        className={`world-choice-card ${selectedWorldId === world.id ? 'is-selected' : ''}`}
                        onClick={() => chooseWorld(world, false)}
                        disabled={configurationLocked}
                      >
                        <span className="world-choice-card__radio" aria-hidden="true" />
                        <span className="world-choice-card__copy"><strong>{world.name}</strong><small>Progression existante · BDS {world.version}</small></span>
                        {world.lastUsedAt ? <span className="world-choice-card__meta">Repris</span> : <Database size={16} />}
                      </button>
                    ))}
                  </div>
                  {worldsForSelectedVersion.length === 0 && <p className="world-choice-note">Aucun monde prêt n’est associé à cette version exacte. Les mondes d’autres versions ne sont jamais proposés ici.</p>}
                  {selectedWorld && selectedWorld.version === configuration.version && <p className="world-choice-note"><ShieldCheck size={14} /> Le dossier et les chunks de « {selectedWorld.name} » seront repris tels quels. Les réglages modifiables seront appliqués; la seed reste verrouillée.</p>}
                </fieldset>

                <div className="nether-form-grid">
                  <label className="nether-field">
                    <span>Nom du serveur</span>
                    <input value={configuration.serverName} maxLength={64} disabled={configurationLocked} onChange={(event) => changeField('serverName', event.target.value)} className="nether-input" required />
                  </label>
                  {selectedWorld ? (
                    <div className="nether-field">
                      <span>Monde existant · progression conservée</span>
                      <div className="world-selected-summary"><strong>{selectedWorld.name}</strong><small>BDS {selectedWorld.version} · dossier isolé</small></div>
                    </div>
                  ) : (
                    <label className="nether-field">
                      <span>Nom du nouveau monde</span>
                      <input value={newWorldName} maxLength={64} disabled={configurationLocked} onChange={(event) => { markConfigTouched(); setNewWorldName(event.target.value); }} className="nether-input" required />
                    </label>
                  )}
                  <div className="nether-field deploy-segment-field">
                    <span id="deploy-gamemode-label">Mode de jeu</span>
                    <RubberSegment
                      options={gameModeOptions}
                      value={configuration.gamemode}
                      onChange={(value) => changeField('gamemode', value)}
                      labelledBy="deploy-gamemode-label"
                      disabled={configurationLocked}
                    />
                  </div>
                  <div className="nether-field deploy-segment-field">
                    <span id="deploy-difficulty-label">Difficulté</span>
                    <RubberSegment
                      options={difficultyOptions}
                      value={configuration.difficulty}
                      onChange={(value) => changeField('difficulty', value)}
                      labelledBy="deploy-difficulty-label"
                      disabled={configurationLocked}
                    />
                  </div>
                  <label className="nether-field">
                    <span>Joueurs maximum</span>
                    <input type="number" min={1} step={1} value={configuration.maxPlayers} disabled={configurationLocked} onChange={(event) => changeField('maxPlayers', Number(event.target.value))} className="nether-input" required />
                  </label>
                  <label className="nether-field">
                    <span>Seed <small>{selectedWorld ? 'verrouillée · monde déjà généré' : 'optionnelle · vide = aléatoire'}</small></span>
                    <input value={configuration.seed} maxLength={80} disabled={configurationLocked || Boolean(selectedWorld)} onChange={(event) => changeField('seed', event.target.value)} className="nether-input" />
                  </label>
                  <label className="nether-field">
                    <span>Distance de vue <small>chunks</small></span>
                    <input type="number" min={1} max={96} step={1} value={configuration.viewDistance} disabled={configurationLocked} onChange={(event) => changeField('viewDistance', Number(event.target.value))} className="nether-input" />
                  </label>
                </div>

                <div className="admin-xuid-box">
                  <div className="admin-xuid-box__header">
                    <div><strong>Administrateurs Bedrock</strong><small>1 à 3 XUID numériques uniques · aucun gamertag</small></div>
                    <motion.button type="button" onClick={addAdminField} disabled={configurationLocked || configuration.adminXuids.length >= 3} whileTap={reduceMotion ? undefined : { scale: 0.95 }} className="nether-btn nether-btn--tiny nether-btn--quiet">
                      <Users size={14} /> Ajouter
                    </motion.button>
                  </div>
                  <div className="admin-xuid-list">
                    {configuration.adminXuids.map((xuid, index) => (
                      <div key={index} className="admin-xuid-row">
                        <span className="admin-xuid-row__number">{String(index + 1).padStart(2, '0')}</span>
                        <input aria-label={`XUID administrateur ${index + 1}`} inputMode="numeric" autoComplete="off" value={xuid} disabled={configurationLocked} onChange={(event) => setAdminXuid(index, event.target.value)} className="nether-input" placeholder="Ex. 2535412894129841" required />
                        {configuration.adminXuids.length > 1 && <button type="button" onClick={() => removeAdminField(index)} disabled={configurationLocked} className="icon-button icon-button--danger" aria-label={`Retirer le XUID ${index + 1}`}><X size={16} /></button>}
                      </div>
                    ))}
                  </div>
                  {configuration.adminXuids.some((xuid) => xuid.length > 0 && !/^\d{1,20}$/.test(xuid)) && <p className="inline-error">Le XUID doit contenir uniquement des chiffres, sans espace.</p>}
                  {configuration.adminXuids.every((xuid) => xuid.length > 0) && new Set(configuration.adminXuids).size !== configuration.adminXuids.length && <p className="inline-error">Chaque XUID administrateur doit être unique.</p>}
                </div>

                <div className="deploy-options-grid">
                  <div className="deploy-jelly-setting">
                    <strong id="allow-cheats-label">Autoriser les commandes</strong>
                    <JellyRadio
                      items={[
                        { value: false, label: 'Désactivées' },
                        { value: true, label: 'Autorisées' },
                      ]}
                      value={configuration.allowCheats}
                      onChange={(allowCheats) => changeField('allowCheats', allowCheats)}
                      labelledBy="allow-cheats-label"
                      describedBy="allow-cheats-help"
                      ariaLabel="Autoriser les commandes de jeu"
                      chipColor="rgba(38, 31, 42, 0.96)"
                      activeColor="var(--nether-magma)"
                      textColor="var(--nether-muted)"
                      activeTextColor="#21160f"
                      size="sm"
                      gap={6}
                      radius={12}
                      disabled={configurationLocked}
                      className="ncraft-cheats-radio"
                    />
                    <small id="allow-cheats-help">Cheats et commandes de jeu sur le serveur Bedrock.</small>
                  </div>
                  <div className="security-badges">
                    <span><LockKeyhole size={13} /> Auth Bedrock</span>
                    <span><Wifi size={13} /> UDP 19132</span>
                    <span><ShieldCheck size={13} /> Allow-list off</span>
                  </div>
                </div>

                <SpringCheck
                  className="eula-card"
                  checked={configuration.eulaAccepted}
                  onChange={(checked) => changeField('eulaAccepted', checked)}
                  disabled={configurationLocked}
                >
                  J’ai lu et j’accepte l’<a href="https://www.minecraft.net/eula" target="_blank" rel="noreferrer">EULA Minecraft</a>. Si le binaire affiche un prompt connu, le backend y répondra automatiquement; aucun fichier EULA non vérifié ne sera inventé.
                </SpringCheck>

                <motion.button
                  type={isEditingWorldSettings || (isExistingDeployment && !operationNeedsDeploy) ? 'button' : 'submit'}
                  onClick={isEditingWorldSettings
                    ? () => void handleSaveWorldSettings()
                    : isExistingDeployment && !operationNeedsDeploy ? () => void handleSaveConfiguration() : undefined}
                  disabled={configurationActionDisabled || (isEditingWorldSettings && worldBusyId === editingWorld?.id)}
                  whileTap={reduceMotion ? undefined : { scale: 0.99 }}
                  className="nether-btn nether-btn--primary nether-btn--wide deploy-submit"
                >
                  {isPipelineBusy || (isEditingWorldSettings && worldBusyId === editingWorld?.id)
                    ? <Loader2 className="spin-soft" size={18} />
                    : isEditingWorldSettings || (isExistingDeployment && !operationNeedsDeploy) ? <Save size={18} /> : <ArrowRight size={18} />}
                  {configurationActionLabel}
                </motion.button>
              </form>
            </NetherCard>
          </section>
            </motion.div>
          )}
        </section>

        <section
          id="panel-worlds"
          className="ncraft-tab-panel"
          role="tabpanel"
          aria-label="Mondes"
          tabIndex={0}
          hidden={activeSection !== 'worlds'}
        >
          {activeSection === 'worlds' && (
            <motion.div
              className="ncraft-tab-panel__content"
              initial={reduceMotion || !animatePanelEntry ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={reduceMotion ? { duration: 0 } : { duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            >
          <PanelHeading
            variant="worlds"
            eyebrow="SAUVEGARDES BEDROCK"
            title="Gérer les mondes"
            description="Chaque build BDS exacte garde sa propre sauvegarde. Importer, exporter, renommer ou supprimer un monde ne touche pas aux autres."
          />
          <NetherCard
            title="Gestionnaire de mondes"
            eyebrow="SAUVEGARDES BEDROCK ISOLÉES"
            description="Chaque sauvegarde est associée à un build BDS exact. Reprendre conserve les mêmes chunks; les données d’une version ne sont jamais ouvertes avec une autre version sans choix explicite."
            icon={Database}
            accent="moss"
            className="world-manager-card"
            action={<span className="world-manager-count">{worlds.length} monde{worlds.length === 1 ? '' : 's'}</span>}
          >
            <div className="world-manager-toolbar">
              <p><ShieldCheck size={15} /> Les opérations de gestion nécessitent l’arrêt de Bedrock. Export recommandé avant suppression.</p>
              <motion.button type="button" onClick={() => void refreshWorlds()} disabled={configurationLocked} whileTap={reduceMotion ? undefined : { scale: 0.96 }} className="nether-btn nether-btn--quiet nether-btn--tiny">
                <RefreshCw size={14} /> Actualiser
              </motion.button>
            </div>

            {worldManagerError && <div role="alert" className="nether-callout nether-callout--danger world-manager-message"><AlertTriangle size={16} /><span>{worldManagerError}</span></div>}

            <div className="world-import-panel">
              <div className="world-import-panel__heading"><span className="world-import-icon"><FileUp size={17} /></span><div><strong>Importer un monde</strong><small>.mcworld ou archive ZIP Bedrock · aucun écrasement</small></div></div>
              <div className="world-import-grid">
                <div className="nether-field">
                  <span id="world-import-version-label">Version BDS exacte</span>
                  <GlideSelect
                    options={versions.map((version): GlideSelectOption => ({ value: version.version, label: `BDS ${version.version}`, tag: `client ${version.clientVersion}` }))}
                    value={worldImportVersion}
                    onChange={setWorldImportVersion}
                    labelledBy="world-import-version-label"
                    disabled={configurationLocked || versions.length === 0}
                    required
                    invalid={!versions.some((version) => version.version === worldImportVersion)}
                  />
                </div>
                <label className="nether-field">
                  <span>Nom dans le gestionnaire</span>
                  <input value={worldImportName} maxLength={80} disabled={configurationLocked} onChange={(event) => setWorldImportName(event.target.value)} className="nether-input" placeholder={worldImportFile?.name.replace(/\.(mcworld|zip)$/i, '') || 'Nom du monde'} />
                </label>
                <label className="nether-field world-file-field">
                  <span>Archive Bedrock</span>
                  <input
                    ref={worldImportInputRef}
                    type="file"
                    accept=".mcworld,.zip,application/zip,application/octet-stream"
                    disabled={configurationLocked}
                    onChange={(event) => {
                      const file = event.target.files?.[0] ?? null;
                      setWorldImportFile(file);
                      if (file && !worldImportName) setWorldImportName(file.name.replace(/\.(mcworld|zip)$/i, ''));
                    }}
                    className="world-file-input"
                  />
                </label>
                <motion.button type="button" onClick={() => void handleImportWorld()} disabled={configurationLocked || !worldImportFile || !worldImportVersion || worldBusyId === 'import'} whileTap={reduceMotion ? undefined : { scale: 0.97 }} className="nether-btn nether-btn--primary world-import-submit">
                  {worldBusyId === 'import' ? <Loader2 className="spin-soft" size={16} /> : <FileUp size={16} />}
                  {worldBusyId === 'import' ? 'Import en cours…' : 'Importer sans remplacer'}
                </motion.button>
              </div>
              <p className="world-import-footnote">L’archive est vérifiée et extraite avec des limites de taille; un dossier temporaire est utilisé. Le monde n’est ajouté à la liste qu’après validation, et tout nom de dossier est généré côté serveur.</p>
            </div>

            {worlds.length === 0 ? (
              <div className="world-manager-empty"><Globe size={25} /><strong>Aucune sauvegarde enregistrée</strong><span>Crée un monde depuis le déploiement ou importe une archive Bedrock.</span><button type="button" className="world-manager-empty__link" onClick={chooseNewWorld}>Créer le premier monde <ChevronRight size={14} /></button></div>
            ) : (
              <div className="world-manager-list">
                {worlds.map((world) => {
                  const isCurrent = activeWorld?.id === world.id;
                  const sourceLabel = world.source === 'imported' ? 'Importé' : world.source === 'legacy' ? 'Existant' : 'Créé par N-Craft';
                  const statusLabelText = world.status === 'ready' ? 'PRÊT' : world.status === 'pending' ? 'À INITIALISER' : world.status === 'missing' ? 'DOSSIER ABSENT' : world.status === 'unsafe' ? 'INACCESSIBLE' : 'VERSION À ASSOCIER';
                  const statusTone = world.status === 'ready' ? 'running' : world.status === 'missing' || world.status === 'unsafe' ? 'failed' : 'starting';
                  return (
                    <article key={world.id} className={`managed-world ${isCurrent ? 'managed-world--current' : ''}`}>
                      <SwipeRow
                        key={`${world.id}-actions-${worldSwipeNonce[world.id] ?? 0}`}
                        actions={[{ id: 'delete', label: 'Supprimer' }]}
                        label={`Actions du monde ${world.name}`}
                        actionColor="#a7373d"
                        drawerColor="rgba(105, 37, 45, 0.96)"
                        rowColor="rgba(18, 15, 21, 0.9)"
                        textColor="var(--nether-text)"
                        height={58}
                        radius={10}
                        actionWidth={96}
                        fullSwipe
                        disabled={configurationLocked || worldBusyId === world.id || renameWorldId === world.id}
                        onCommit={(action) => {
                          if (action.id !== 'delete') return;
                          void handleDeleteWorld(world).then((deleted) => {
                            if (!deleted) setWorldSwipeNonce((current) => ({ ...current, [world.id]: (current[world.id] ?? 0) + 1 }));
                          });
                        }}
                        className="ncraft-world-swipe-row"
                      >
                      <div className="managed-world__heading">
                        <span className="managed-world__icon"><img src="/assets/minecraft/grass-block.webp" alt="" width="22" height="22" /></span>
                        <div className="managed-world__identity">
                          {renameWorldId === world.id ? (
                            <div className="world-rename-row">
                              <label className="sr-only" htmlFor={`world-name-${world.id}`}>Nouveau nom pour {world.name}</label>
                              <input id={`world-name-${world.id}`} value={renameWorldValue} maxLength={80} onChange={(event) => setRenameWorldValue(event.target.value)} className="nether-input" autoFocus />
                              <button type="button" className="icon-button" aria-label="Enregistrer le nom" disabled={worldBusyId === world.id || configurationLocked} onClick={() => void handleRenameWorld(world)}><Check size={15} /></button>
                              <button type="button" className="icon-button" aria-label="Annuler le renommage" onClick={() => setRenameWorldId(null)}><X size={15} /></button>
                            </div>
                          ) : (
                            <>
                              <strong>{world.name}{isCurrent && <span className="managed-world__current-tag">MONDE ACTIF</span>}</strong>
                              <small>{sourceLabel} · créé le {new Date(world.createdAt).toLocaleDateString('fr-FR')}</small>
                            </>
                          )}
                        </div>
                        <StatusPill status={statusTone} label={statusLabelText} />
                      </div>
                      </SwipeRow>

                      <div className="managed-world__details">
                        <span><small>Version dédiée</small><strong>{world.version ? `BDS ${world.version}` : 'Non associée'}</strong></span>
                        <span><small>Seed</small><strong>{world.seed === null ? 'Inconnue · non modifiable' : world.seed || 'Aléatoire'}</strong></span>
                        <span><small>Dernière utilisation</small><strong>{world.lastUsedAt ? new Date(world.lastUsedAt).toLocaleString('fr-FR') : 'Jamais démarré ici'}</strong></span>
                        {world.lastModifiedAt && <span><small>level.dat modifié</small><strong>{new Date(world.lastModifiedAt).toLocaleDateString('fr-FR')}</strong></span>}
                      </div>

                      {world.status === 'unassigned' && (
                        <div className="world-assign-row">
                          <div className="nether-field">
                            <span id={`assign-version-label-${world.id}`}>Attribuer la version d’origine</span>
                            <GlideSelect
                              options={versions.map((version): GlideSelectOption => ({ value: version.version, label: `BDS ${version.version}`, tag: `client ${version.clientVersion}` }))}
                              value={assignWorldVersion[world.id] ?? (versions.some((version) => version.version === configuration.version) ? configuration.version : '')}
                              onChange={(value) => setAssignWorldVersion((current) => ({ ...current, [world.id]: value }))}
                              labelledBy={`assign-version-label-${world.id}`}
                              disabled={configurationLocked || worldBusyId === world.id}
                              placeholder="Choisir la version exacte…"
                              required
                            />
                          </div>
                          <button type="button" className="nether-btn nether-btn--quiet" onClick={() => void handleAssignWorld(world)} disabled={configurationLocked || worldBusyId === world.id}><Check size={15} /> Associer</button>
                        </div>
                      )}

                      <div className="managed-world__actions">
                        <button type="button" className="nether-btn nether-btn--primary nether-btn--tiny" onClick={() => isCurrent ? void handleStart() : chooseWorld(world, false)} disabled={configurationLocked || world.status !== 'ready' || !world.version || (isCurrent && startDisabled)}>
                          <Play size={14} /> {isCurrent ? 'Démarrer ce monde' : 'Choisir & reprendre'}
                        </button>
                        <button type="button" className="nether-btn nether-btn--quiet nether-btn--tiny" onClick={() => chooseWorld(world, true)} disabled={configurationLocked || !world.version || world.status === 'missing' || world.status === 'unsafe'}>
                          <Pencil size={14} /> Modifier les options
                        </button>
                        <button type="button" className="nether-btn nether-btn--quiet nether-btn--tiny" onClick={() => handleExportWorld(world)} disabled={configurationLocked || world.status !== 'ready'}>
                          <Download size={14} /> Exporter
                        </button>
                        {renameWorldId !== world.id && <button type="button" className="nether-btn nether-btn--quiet nether-btn--tiny" onClick={() => { setRenameWorldId(world.id); setRenameWorldValue(world.name); }} disabled={configurationLocked}>
                          <Pencil size={14} /> Renommer
                        </button>}
                        <button type="button" className="nether-btn nether-btn--danger nether-btn--tiny" onClick={() => void handleDeleteWorld(world)} disabled={configurationLocked || worldBusyId === world.id}>
                          {worldBusyId === world.id ? <Loader2 className="spin-soft" size={14} /> : <Trash2 size={14} />} Supprimer
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </NetherCard>
            </motion.div>
          )}
        </section>

        <section
          id="panel-diagnostics"
          className="ncraft-tab-panel"
          role="tabpanel"
          aria-label="Diagnostics"
          tabIndex={0}
          hidden={activeSection !== 'diagnostics'}
        >
          {activeSection === 'diagnostics' && (
            <motion.div
              className="ncraft-tab-panel__content"
              initial={reduceMotion || !animatePanelEntry ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={reduceMotion ? { duration: 0 } : { duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            >
          <PanelHeading
            variant="diagnostics"
            eyebrow="ÉTAT DU CONTENEUR"
            title="Diagnostics"
            description="Contrôles réels du pipeline, des prérequis système et du binaire Bedrock."
        />
          <aside className="ncraft-operations-stack ncraft-operations-stack--diagnostics">
            <NetherCard
              title="Chatbot conversationnel"
              eyebrow="DANS LE CHAT MINECRAFT · .. <message>"
              description="Conversation partagée entre joueurs, limitée aux 10 derniers échanges. Seuls les messages « .. » sont transmis aux fournisseurs IA; aucun outil ni action Bedrock n’est accessible."
              icon={MessageCircle}
              accent="portal"
              action={<StatusPill status={chatbotPillStatus} label={chatbotPillLabel} />}
            >
              <div className="system-check-list">
                <CheckRow
                  label={`Build BDS ${chatbot?.build ?? '—'} · client ${chatbot?.clientVersion ?? '—'} · protocole ${chatbot?.protocolVersion ?? '—'}`}
                  ok={chatbot ? chatbot.protocolSupported && chatbot.protocolTested : null}
                  detail={chatbot?.protocolNote}
                />
                <CheckRow label="Gemini · fournisseur principal" ok={chatbot?.geminiConfigured ?? null} />
                <CheckRow label="NVIDIA NIM · secours" ok={chatbot?.nvidiaConfigured ?? null} />
                <CheckRow
                  label="Compte Bedrock dédié lié"
                  ok={chatbot?.accountLinked ?? null}
                  detail={chatbot?.occupiesPlayerSlot ? 'Le client occupe un emplacement joueur.' : 'Aucun compte ni jeton n’est affiché ici.'}
                />
                <CheckRow
                  label={`Requêtes IA · aujourd’hui (UTC) ${chatbot?.dailyUsed ?? 0}/${chatbot?.dailyLimit ?? 0}`}
                  ok={chatbot ? chatbot.dailyLimit === 0 || chatbot.dailyUsed < chatbot.dailyLimit : null}
                  detail="Le plafond et les clés se règlent côté serveur via ncraft env."
                />
              </div>
              {chatbot?.message && <p className="nether-inline-note"><ShieldCheck size={14} />{chatbot.message}</p>}
              {chatbot?.deviceCode && chatbot.userActionPending && (
                <div className="nether-callout nether-callout--portal" role="status">
                  <LockKeyhole size={17} />
                  <div className="callout-copy">
                    <strong>Approbation manuelle du compte Bedrock</strong>
                    <span>Ouvre le site Microsoft officiel et saisis ce code. N-Craft ne demande jamais ton mot de passe.</span>
                    <div className="device-code-row"><code>{chatbot.deviceCode.userCode}</code></div>
                    <a className="inline-link" href={chatbot.deviceCode.verificationUrl} target="_blank" rel="noreferrer noopener">
                      Ouvrir la page Microsoft <ExternalLink size={13} />
                    </a>
                    <small>Code valable jusqu’au {new Date(chatbot.deviceCode.expiresAt).toLocaleTimeString()} (heure locale).</small>
                  </div>
                </div>
              )}
              {chatbotFeedback && <p className="nether-inline-note" role="status">{chatbotFeedback}</p>}
              <div className="chatbot-actions">
                {chatbot?.canLink && !chatbot.userActionPending && (
                  <button type="button" className="nether-btn nether-btn--primary" onClick={() => void handleChatbotLink()} disabled={chatbotBusy}>
                    {chatbotBusy ? <Loader2 className="spin-soft" size={15} /> : <LockKeyhole size={15} />}
                    {chatbot.accountLinked ? 'Réautoriser le compte dédié' : 'Lier un compte dédié'}
                  </button>
                )}
                {chatbot?.userActionPending && (
                  <button type="button" className="nether-btn nether-btn--quiet" onClick={() => void handleChatbotCancel()} disabled={chatbotBusy}>
                    {chatbotBusy ? <Loader2 className="spin-soft" size={15} /> : <X size={15} />} Annuler l’autorisation
                  </button>
                )}
                {chatbot?.accountLinked && !chatbot.userActionPending && (
                  <FuseButton
                    label="Délier et effacer les jetons"
                    undoLabel="Annuler la déliaison"
                    doneLabel="Confirmation requise"
                    icon={<Trash2 size={15} aria-hidden="true" />}
                    color="#ffe8e0"
                    background="rgba(91, 34, 39, 0.7)"
                    fuseColor="var(--nether-magma)"
                    size="sm"
                    radius={12}
                    undoWindow={4200}
                    commitOn="fuseEnd"
                    settle="reset"
                    disabled={chatbotBusy}
                    onCommit={(reason) => { if (reason === 'fuseEnd') void handleChatbotUnlink(); }}
                    onUndo={() => {
                      setChatbotFeedback('Déliaison annulée.');
                      pushPanelToast({ tone: 'info', title: 'Déliaison annulée', description: 'Le compte Bedrock dédié et ses jetons restent inchangés.' });
                    }}
                    className="ncraft-fuse-unlink"
                  />
                )}
              </div>
            </NetherCard>

            <NetherCard
              title="Pipeline de déploiement"
              eyebrow="ÉTAT EN TEMPS RÉEL"
              description="Chaque étape vient du backend."
              icon={Layers}
              accent="portal"
              action={<StatusPill status={pipeline?.status === 'failed' ? 'failed' : isPipelineBusy ? 'starting' : pipeline?.step === 'running' ? 'running' : 'stopped'} label={pipeline?.status === 'failed' ? 'ÉCHEC' : isPipelineBusy ? 'EN COURS' : pipeline?.step === 'running' ? 'TERMINÉ' : 'PRÊT'} />}
            >
              <ol className="pipeline-list">
                {pipelineSteps.map((step, index) => {
                  const done = (pipeline?.status !== 'failed' && pipeline?.step === 'running') || (currentStepIndex >= 0 && index < currentStepIndex);
                  const active = isPipelineBusy && pipeline?.step === step.id;
                  const failed = pipeline?.status === 'failed' && index === currentStepIndex;
                  return (
                    <li key={step.id} className={`pipeline-step ${failed ? 'is-failed' : active ? 'is-active' : done ? 'is-done' : ''}`}>
                      <span className="pipeline-step__marker">{failed ? <X size={14} /> : done ? <Check size={14} /> : active ? <Loader2 size={14} className="spin-soft" /> : String(index + 1).padStart(2, '0')}</span>
                      <span>{step.label}</span>
                      {active && <small>EN COURS</small>}
                    </li>
                  );
                })}
              </ol>
              {pipeline?.error && <div role="alert" className="nether-callout nether-callout--danger"><AlertTriangle size={17} /><span>{pipeline.error}</span></div>}
              <p className="pipeline-footnote"><ShieldCheck size={14} /> Le monde, les packs et les permissions sont préservés pendant Deploy.</p>
            </NetherCard>

            <NetherCard
              id="preflight"
              title="Précontrôle système"
              eyebrow="CONTENEUR DU PANNEAU"
              description={`Bedrock · ${status?.serverDirectory ?? 'répertoire en attente'}`}
              icon={ShieldCheck}
              accent="moss"
            >
              <div className="system-check-list">
                <CheckRow label={`Linux x64 · Node ${system?.nodeVersion ?? '…'}`} ok={system ? system.platform === 'linux' && system.arch === 'x64' : null} />
                <CheckRow label={`glibc ${system?.glibcVersion ?? 'non détectée'} · minimum visé 2.29`} ok={system ? system.glibc.ok : null} detail={system?.glibc.detail} />
                <CheckRow label="libcurl.so.4" ok={system ? system.libcurl.ok : null} detail={system?.libcurl.detail} />
                <CheckRow label="OpenSSL 1.1 · compatibilité à la demande" ok={system ? (system.legacyOpenSsl.ok ? true : null) : null} detail={system?.legacyOpenSsl.detail} />
                <CheckRow label={`Mémoire : ${formatBytes(system?.memoryLimitBytes ?? null)} · cible 4 Go`} ok={system ? !system.memoryWarning : null} detail={system?.memoryWarning ? 'Avertissement : un arrêt OOM est possible; le test reste autorisé.' : undefined} />
                <CheckRow label={`DATA_DIR : ${formatBytes(system?.dataDiskFreeBytes ?? null)} libres`} ok={system ? !system.diskWarning : null} detail={system ? `${formatBytes(system.dataDiskRequiredBytes)} estimés${system.sharedDiskVolume ? ' · volume partagé' : ''}` : undefined} />
                {system?.sharedDiskVolume === false && <CheckRow label={`BEDROCK_SERVER_DIR : ${formatBytes(system.serverDiskFreeBytes)} libres`} ok={!system.diskWarning} detail={`${formatBytes(system.serverDiskRequiredBytes)} estimés`} />}
                {system && system.sharedDiskVolume === null && <CheckRow label={`BEDROCK_SERVER_DIR : ${formatBytes(system.serverDiskFreeBytes)} libres`} ok={!system.diskWarning} detail="Volume incertain" />}
                {tunnelProvider === 'portwarp' ? (
                  <CheckRow label="CLI Portwarp (pwrp)" ok={system ? system.portwarpBinary.ok : null} detail={system?.portwarpBinary.detail} />
                ) : tunnelProvider === 'localtonet' ? (
                  <CheckRow label="Client Localtonet" ok={system ? system.localtonetBinary.ok : null} detail={system?.localtonetBinary.detail} />
                ) : (
                  <>
                    <CheckRow label="Daemon Playit (playitd)" ok={system ? system.playitBinary.ok : null} detail={system?.playitBinary.detail} />
                    <CheckRow label="CLI Playit (claim)" ok={system ? system.playitCliBinary.ok : null} detail={system?.playitCliBinary.detail} />
                  </>
                )}
                {system && <CheckRow label="Binaire Bedrock" ok={system.bedrockBinary.ok} detail={system.bedrockBinary.detail} />}
              </div>
              {system?.warnings.map((warning) => <p key={warning} className="system-warning"><AlertTriangle size={14} />{warning}</p>)}
            </NetherCard>

            <NetherCard title="Points de vérification" eyebrow="TRANSPARENCE" icon={AlertTriangle} accent="magma">
              <ul className="verification-list">
                <li>EULA : son format réel doit encore être confirmé avec le binaire téléchargé.</li>
                <li>La persistance des permissions/XUID après un second déploiement n’est pas encore vérifiée; aucune décision n’est modifiée automatiquement.</li>
              </ul>
            </NetherCard>
          </aside>
            </motion.div>
          )}
        </section>

        <section
          id="panel-console"
          className="ncraft-tab-panel"
          role="tabpanel"
          aria-label="Console"
          tabIndex={0}
          hidden={activeSection !== 'console'}
        >
          {activeSection === 'console' && (
            <motion.div
              className="ncraft-tab-panel__content"
              initial={reduceMotion || !animatePanelEntry ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={reduceMotion ? { duration: 0 } : { duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            >
          <PanelHeading
            variant="console"
            eyebrow="JOURNAL DU SERVEUR"
            title="Console Bedrock"
            description="Logs reçus du processus et commandes envoyées directement à son stdin; aucun shell n’est lancé."
          />
          <NetherCard
            title="Console Bedrock"
            eyebrow="STDIN / STDOUT DU SERVEUR"
            description="Flux temps réel · WebSocket protégé par la session du panneau"
            icon={Terminal}
            accent="moss"
            action={<StatusPill status={consoleConnected ? 'running' : 'starting'} label={consoleConnected ? 'CONNECTÉE' : 'RECONNEXION'} />}
            className="console-card"
          >
            <div ref={logViewportRef} className="nether-terminal" aria-live="polite" aria-label="Journal Bedrock">
              {consoleLogs.length === 0 && <p className="terminal-empty">Aucun log Bedrock reçu. Le serveur est peut-être arrêté.</p>}
              {consoleLogs.map((line) => (
                <div key={line.id} className={`terminal-line terminal-line--${line.level}`}>
                  <time dateTime={line.timestamp}>[{new Date(line.timestamp).toLocaleTimeString('fr-FR')}]</time>
                  <b>[{line.tag}]</b>
                  <span>{line.message}</span>
                </div>
              ))}
            </div>
            {consoleError && <p role="alert" className="inline-error">{consoleError}</p>}
            <form onSubmit={handleCommand} className="console-command-form">
              <label className="console-command-input">
                <Terminal size={16} />
                <input
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                  maxLength={1000}
                  disabled={server?.status !== 'running'}
                  aria-label="Commande Bedrock"
                  placeholder={server?.status === 'running' ? 'Commande Bedrock (sans /)' : 'Le serveur doit être en ligne pour envoyer une commande'}
                />
              </label>
              <motion.button type="submit" disabled={server?.status !== 'running' || !command.trim()} whileTap={reduceMotion ? undefined : { scale: 0.95 }} className="nether-btn nether-btn--primary">
                <ArrowRight size={16} /> Envoyer
              </motion.button>
            </form>
            <p className="console-footnote">Aucun shell n’est lancé : la commande est écrite directement sur stdin de bedrock_server.</p>
          </NetherCard>
            </motion.div>
          )}
        </section>

        <footer className="ncraft-footer">
          <span><Activity size={14} /> Panel mono-instance · pas de Docker imbriqué · aucune base de données</span>
          <span>{system?.checkedAt ? `Dernier précontrôle · ${new Date(system.checkedAt).toLocaleTimeString('fr-FR')}` : 'Précontrôle en attente'}</span>
        </footer>
      </div>

      <nav className="mobile-dock" role="tablist" aria-label="Sections du panneau" aria-orientation="horizontal">
        {PANEL_TABS.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              id={`mobile-tab-${tab.id}`}
              role="tab"
              aria-controls={`panel-${tab.id}`}
              aria-selected={activeSection === tab.id}
              tabIndex={activeSection === tab.id ? 0 : -1}
              onClick={() => switchPanel(tab.id)}
              onKeyDown={(event) => handleTabKeyDown(event, tab.id, 'mobile')}
            >
              <Icon size={17} aria-hidden="true" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </nav>

      {panelToasts.length > 0 && (
        <div className="ncraft-toast-stack" role="region" aria-label="Notifications du panneau">
          {panelToasts.map((toast) => {
            const look = PANEL_TOAST_LOOKS[toast.tone];
            return (
              <SwipeToast
                key={toast.id}
                title={toast.title}
                description={toast.description}
                icon={look.icon}
                background={look.background}
                color="#fff7f0"
                fuseColor={look.fuse}
                width={440}
                radius={13}
                duration={5200}
                fuse="bottom"
                closeButton
                closeLabel="Fermer la notification"
                inline
                onClose={() => dismissPanelToast(toast.id)}
                className="ncraft-panel-toast"
              />
            );
          })}
        </div>
      )}

      <AnimatePresence initial={false}>
        {aboutOpen && <AboutModal key="about" onClose={() => setAboutOpen(false)} />}
      </AnimatePresence>
    </main>
  );
}


function PanelHeading({ eyebrow, title, description, variant }: { eyebrow: string; title: string; description: string; variant?: 'deployment' | 'worlds' | 'diagnostics' | 'console' }) {
  const variantClassName = variant ? ` ncraft-tab-heading--${variant}` : '';
  return (
    <header className={`ncraft-tab-heading${variantClassName}`}>
      <div className="ncraft-tab-heading__copy">
        <p className="nether-eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <span className="ncraft-tab-heading__ornament" aria-hidden="true"><span /><span /><span /></span>
    </header>
  );
}

function StatusPill({ status, label }: { status: string; label?: string }) {
  const positive = ['running', 'configured', 'authenticated', 'success'].includes(status);
  const negative = ['failed', 'exited', 'tunnel_misconfigured'].includes(status);
  const tone = positive ? 'good' : negative ? 'bad' : ['stopped', 'idle'].includes(status) ? 'neutral' : 'warning';
  const text = label ?? statusLabel(status);
  return (
    <span className={`status-pill status-pill--${tone}`} aria-label={text} title={text}>
      <span className="status-pill__dot" aria-hidden="true" />
      {text}
    </span>
  );
}

function LiveUptime({ startedAt }: { startedAt: string | null | undefined }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!startedAt) return undefined;
    let timer: number | undefined;
    const stopClock = () => {
      if (timer === undefined) return;
      window.clearInterval(timer);
      timer = undefined;
    };
    const startClock = () => {
      if (document.visibilityState !== 'visible' || timer !== undefined) return;
      setNow(Date.now());
      timer = window.setInterval(() => setNow(Date.now()), 1000);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') startClock();
      else stopClock();
    };

    startClock();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      stopClock();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [startedAt]);

  const startedAtMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  const uptimeSeconds = startedAt && Number.isFinite(startedAtMs)
    ? Math.floor((now - startedAtMs) / 1000)
    : null;

  return <>{formatDuration(uptimeSeconds)}</>;
}

function MetricTile({
  icon: Icon,
  label,
  value,
  detail,
  accent,
}: {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  detail: string;
  accent: 'portal' | 'soul' | 'magma' | 'moss';
}) {
  return (
    <div className={`metric-tile metric-tile--${accent}`}>
      <span className="metric-tile__icon"><Icon size={16} strokeWidth={1.9} /></span>
      <div className="metric-tile__copy">
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </div>
  );
}

function WorldDetail({ label, value }: { label: string; value: string }) {
  return (
    <div className="world-detail-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function CheckRow({ label, ok, detail }: { label: string; ok: boolean | null; detail?: string }) {
  return (
    <div className={`system-check-row ${ok === null ? 'is-pending' : ok ? 'is-ok' : 'is-warning'}`}>
      <span className="system-check-row__icon" aria-hidden="true">{ok === null ? <Clock3 size={14} /> : ok ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}</span>
      <div className="system-check-row__copy">
        <span>{label}</span>
        {detail && <small>{detail}</small>}
      </div>
    </div>
  );
}
