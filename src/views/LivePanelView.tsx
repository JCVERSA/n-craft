import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Info,
  Layers,
  Loader2,
  LogOut,
  Shield,
  ShieldCheck,
  X,
} from 'lucide-react';
import { AboutModal } from '../components/AboutModal.tsx';
import BranchedMenu from '../components/BranchedMenu.jsx';
import { useDialogs } from '../components/DialogProvider.tsx';
import type { GlideSelectOption } from '../components/GlideSelect.tsx';
import { NebulaBrandMark } from '../components/NebulaBrandMark.tsx';
import { NetherAmbientBackground } from '../components/NetherAmbientBackground.tsx';
import SwipeToast from '../components/SwipeToast.jsx';
import type {
  AuthStatus,
  ChatbotSnapshot,
  ConsoleLog,
  DeployConfiguration,
  ManagedBedrockPack,
  ManagedWorld,
  PanelRole,
  PersistentPanelState,
  WorldBedrockPacksSnapshot,
} from '../types/backend.ts';
import {
  appendMetricSample,
  loadMetricHistory,
  saveMetricHistory,
  type BedrockMetricSample,
} from '../utils/metricHistory.ts';
import { OverviewPanel } from './panel/OverviewPanel.tsx';
import { PanelLoginView } from './panel/PanelLoginView.tsx';
import { PanelLoadingFallback, StatusPill } from './panel/PanelPrimitives.tsx';
import {
  ApiError,
  apiRequest,
  areJsonValuesEqual,
  BRANCHED_NAV_ITEMS,
  defaultConfiguration,
  formatBytes,
  getMetricStorage,
  getWorldSettingsConfirmation,
  hasConfigurationSettingsChanged,
  hasDeployConfigurationChanged,
  haveSameConsoleLogIds,
  initialPanelTab,
  isValidForm,
  PANEL_TABS,
  panelTabFromHash,
  pipelineSteps,
  statusLabel,
  type PanelTabId,
  type PanelToast,
  type PanelToastTone,
  type PublicVersion,
  type StatusResponse,
} from './panel/panelHelpers.ts';

const DeployPanel = lazy(() => import('./panel/DeployPanel.tsx'));
const WorldsPanel = lazy(() => import('./panel/WorldsPanel.tsx'));
const DiagnosticsPanel = lazy(() => import('./panel/DiagnosticsPanel.tsx'));
const OperationsView = lazy(() => import('./OperationsView.tsx'));
const ConsolePanel = lazy(() => import('./panel/ConsolePanel.tsx'));
const PixelStudioView = lazy(() => import('./PixelStudioView.tsx'));

const PANEL_TOAST_LOOKS: Record<PanelToastTone, { background: string; fuse: string; icon: ReactNode }> = {
  success: { background: 'rgba(18, 34, 28, 0.98)', fuse: '#9be6b0', icon: <CheckCircle2 size={17} /> },
  warning: { background: 'rgba(43, 31, 18, 0.98)', fuse: '#ffb875', icon: <AlertTriangle size={17} /> },
  error: { background: 'rgba(47, 22, 27, 0.98)', fuse: '#ff7f79', icon: <AlertTriangle size={17} /> },
  info: { background: 'rgba(28, 22, 39, 0.98)', fuse: '#c5a0ff', icon: <Info size={17} /> },
};

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
  const [loginUsername, setLoginUsername] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [metricHistory, setMetricHistory] = useState<BedrockMetricSample[]>(() => loadMetricHistory(getMetricStorage()));
  const reduceMotion = Boolean(useReducedMotion());
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

  const handleMobileTabKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>, currentTab: PanelTabId) => {
    const currentIndex = PANEL_TABS.findIndex((tab) => tab.id === currentTab);
    let nextIndex = currentIndex;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % PANEL_TABS.length;
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + PANEL_TABS.length) % PANEL_TABS.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = PANEL_TABS.length - 1;
    else return;
    event.preventDefault();
    const nextTab = PANEL_TABS[nextIndex]!;
    switchPanel(nextTab.id);
    window.requestAnimationFrame(() => document.getElementById(`mobile-tab-${nextTab.id}`)?.focus());
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
  const deploymentVersionOptions = useMemo<GlideSelectOption[]>(() => versions.map((version) => ({
    value: version.version,
    label: version.label,
    tag: version.releaseDate ?? `Client ${version.clientVersion}`,
  })), [versions]);
  const worldVersionOptions = useMemo<GlideSelectOption[]>(() => versions.map((version) => ({
    value: version.version,
    label: `BDS ${version.version}`,
    tag: `client ${version.clientVersion}`,
  })), [versions]);
  const [worlds, setWorlds] = useState<ManagedWorld[]>([]);
  const [packWorldId, setPackWorldId] = useState('');
  const [worldPacks, setWorldPacks] = useState<ManagedBedrockPack[]>([]);
  const [worldPackLoading, setWorldPackLoading] = useState(false);
  const [worldPackFile, setWorldPackFile] = useState<File | null>(null);
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
  const configTouchedRef = useRef(false);
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
  const worldPackInputRef = useRef<HTMLInputElement>(null);

  const tunnelProvider = status?.tunnelProvider ?? 'portwarp';
  const activeConfig = status?.state.activeConfig;
  const isExistingDeployment = Boolean(activeConfig);

  const applyStatus = useCallback((nextStatus: StatusResponse) => {
    setStatus((current) => current && areJsonValuesEqual(current, nextStatus) ? current : nextStatus);
  }, []);
  const applyPanelState = useCallback((nextState: PersistentPanelState) => {
    setStatus((current) => {
      if (!current || areJsonValuesEqual(current.state, nextState)) return current;
      return { ...current, state: nextState };
    });
  }, []);
  const applyConfigurationIfChanged = useCallback((nextConfiguration: DeployConfiguration) => {
    setConfiguration((current) => hasDeployConfigurationChanged(current, nextConfiguration) ? nextConfiguration : current);
  }, []);

  useEffect(() => {
    previousActiveSectionRef.current = activeSection;
  }, [activeSection]);

  const isPipelineBusy = Boolean(
    status?.deployBusy
    || status?.state.pipeline.status === 'running'
    || busyAction === 'deploy'
    || busyAction === 'save-config'
    || busyAction === 'start',
  );
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

  const fetchWorldPacks = useCallback(async (worldId: string) => (
    apiRequest<WorldBedrockPacksSnapshot>(`/api/server/worlds/${encodeURIComponent(worldId)}/packs`)
  ), []);

  const refreshStatus = useCallback(async (forceConfiguration = false) => {
    try {
      const next = await apiRequest<StatusResponse>('/api/server/status');
      applyStatus(next);
      const nextActiveConfig = next.state.activeConfig;
      if (nextActiveConfig && (!configTouchedRef.current || forceConfiguration)) {
        applyConfigurationIfChanged(nextActiveConfig);
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setAuthenticated(false);
        setStatus(null);
      } else {
        setNotice((error as Error).message);
      }
    }
  }, [applyConfigurationIfChanged, applyStatus]);

  useEffect(() => {
    if (!authenticated || !packWorldId) {
      setWorldPacks([]);
      setWorldPackLoading(false);
      return;
    }
    let cancelled = false;
    setWorldPackLoading(true);
    void fetchWorldPacks(packWorldId)
      .then((snapshot) => {
        if (!cancelled) setWorldPacks(snapshot.packs);
      })
      .catch((error) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) {
          setAuthenticated(false);
          setStatus(null);
        } else setWorldManagerError((error as Error).message);
      })
      .finally(() => {
        if (!cancelled) setWorldPackLoading(false);
      });
    return () => { cancelled = true; };
  }, [authenticated, fetchWorldPacks, packWorldId]);

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
          applyStatus(nextStatus);
          setWorlds(worldResult.worlds);
          const currentConfig = nextStatus.state.activeConfig;
          const currentActiveWorld = currentConfig
            ? worldResult.worlds.find((world) => world.version === currentConfig.version && world.folder === currentConfig.levelName)
            : undefined;
          if (currentConfig && !configTouchedRef.current) {
            applyConfigurationIfChanged(currentConfig);
            setSelectedWorldId(currentActiveWorld?.id ?? null);
            setNewWorldName('Nouveau monde');
            configTouchedRef.current = false;
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
  }, [authenticated, applyConfigurationIfChanged, applyStatus, refreshStatus]);

  useEffect(() => {
    if (!authenticated || activeSection !== 'console') return undefined;
    let disposed = false;
    let reconnectTimer: number | undefined;
    let flushTimer: number | undefined;
    let currentSocket: WebSocket | null = null;
    let reconnectDelay = 2500;
    let pendingLines: ConsoleLog[] = [];

    const flushPendingLines = () => {
      if (flushTimer !== undefined) {
        window.clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      if (pendingLines.length === 0) return;
      const batch = pendingLines;
      pendingLines = [];
      setConsoleLogs((current) => [...current, ...batch].slice(-500));
    };
    const queueConsoleLine = (line: ConsoleLog) => {
      pendingLines.push(line);
      if (flushTimer === undefined) flushTimer = window.setTimeout(flushPendingLines, 100);
    };
    const closeCurrentSocket = () => {
      const socket = currentSocket;
      if (!socket) return;
      currentSocket = null;
      if (socketRef.current === socket) socketRef.current = null;
      flushPendingLines();
      socket.close();
      setConsoleConnected(false);
    };
    const connect = () => {
      if (disposed || document.visibilityState !== 'visible' || currentSocket) return;
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${scheme}//${window.location.host}/api/server/console`);
      currentSocket = socket;
      socketRef.current = socket;
      socket.onopen = () => {
        if (disposed || currentSocket !== socket) return;
        reconnectDelay = 2500;
        setConsoleConnected(true);
        setConsoleError('');
      };
      socket.onmessage = (event) => {
        if (disposed || currentSocket !== socket) return;
        try {
          const message = JSON.parse(String(event.data)) as {
            type?: string;
            line?: ConsoleLog;
            lines?: ConsoleLog[];
            error?: string;
            state?: PersistentPanelState;
          };
          if (message.type === 'snapshot' && Array.isArray(message.lines)) {
            const nextLines = message.lines.slice(-500);
            setConsoleLogs((current) => haveSameConsoleLogIds(current, nextLines) ? current : nextLines);
            if (message.state) applyPanelState(message.state);
          } else if (message.type === 'line' && message.line) {
            queueConsoleLine(message.line);
          } else if (message.type === 'state' && message.state) {
            applyPanelState(message.state);
          } else if (message.type === 'error' && message.error) {
            setConsoleError(message.error);
          }
        } catch {
          setConsoleError('Message WebSocket invalide.');
        }
      };
      socket.onclose = (event) => {
        if (currentSocket !== socket) return;
        currentSocket = null;
        if (socketRef.current === socket) socketRef.current = null;
        setConsoleConnected(false);
        flushPendingLines();
        if (event.code === 4401) {
          setAuthenticated(false);
          setStatus(null);
          return;
        }
        if (!disposed && document.visibilityState === 'visible') {
          reconnectTimer = window.setTimeout(() => {
            reconnectTimer = undefined;
            connect();
          }, reconnectDelay);
          reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
        }
      };
      socket.onerror = () => {
        if (currentSocket === socket) setConsoleConnected(false);
      };
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        connect();
        return;
      }
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      closeCurrentSocket();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    connect();
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (flushTimer !== undefined) window.clearTimeout(flushTimer);
      pendingLines = [];
      const socket = currentSocket;
      currentSocket = null;
      if (socketRef.current === socket) socketRef.current = null;
      socket?.close();
      setConsoleConnected(false);
    };
  }, [authenticated, activeSection, applyPanelState]);

  useEffect(() => {
    const viewport = logViewportRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [consoleLogs, activeSection]);

  useEffect(() => {
    if (versions.length > 0 && !configuration.version && !status?.state.activeConfig) {
      setConfiguration((current) => ({ ...current, version: versions[0]!.version }));
    }
  }, [versions, configuration.version, status?.state.activeConfig]);

  useEffect(() => {
    if (authenticated && status?.state.server.status === 'running') void refreshWorlds();
  }, [authenticated, status?.state.server.status, refreshWorlds]);

  const markConfigTouched = () => {
    configTouchedRef.current = true;
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
    configTouchedRef.current = true;
    setFormError('');
    setNotice('');
    setWorldManagerError('');
    switchPanel('deploy');
  };

  const chooseNewWorld = () => {
    setSelectedWorldId(null);
    setWorldEditId(null);
    setNewWorldName(`Nouveau monde ${worlds.filter((world) => world.version === configuration.version).length + 1}`);
    configTouchedRef.current = true;
    setFormError('');
    switchPanel('deploy');
  };

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoginBusy(true);
    setLoginError('');
    try {
      const result = await apiRequest<AuthStatus>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify(loginUsername.trim()
          ? { username: loginUsername.trim(), password: token }
          : { token }),
      });
      setToken('');
      setLoginUsername('');
      setShowToken(false);
      setAuthenticated(true);
      setAuthStatus((current) => current ? {
        ...current,
        configured: true,
        authenticated: true,
        role: result.role,
        username: result.username,
      } : result);
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
      setAuthStatus((current) => current ? { ...current, authenticated: false, role: null, username: null } : current);
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
      configTouchedRef.current = false;
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
      configTouchedRef.current = false;
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
      configTouchedRef.current = !editsActiveWorld;
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

  const handleImportPack = async () => {
    if (!worldPackFile) {
      setWorldManagerError('Choisis un fichier .mcpack ou une archive ZIP contenant un seul pack.');
      return;
    }
    const query = new URLSearchParams({ fileName: worldPackFile.name });
    setWorldBusyId('pack-import');
    setWorldManagerError('');
    try {
      const response = await fetch(`/api/server/packs/import?${query.toString()}`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: worldPackFile,
      });
      const payload = await response.json().catch(() => ({})) as { pack?: ManagedBedrockPack; error?: string };
      if (!response.ok || !payload.pack) throw new ApiError(payload.error || `Erreur HTTP ${response.status}.`, response.status);
      setWorldPackFile(null);
      if (worldPackInputRef.current) worldPackInputRef.current.value = '';
      if (packWorldId) {
        const snapshot = await fetchWorldPacks(packWorldId);
        setWorldPacks(snapshot.packs);
      }
      pushPanelToast({
        tone: 'success',
        title: 'Pack importé',
        description: `« ${payload.pack.name} » est installé sans écraser de pack existant. ${packWorldId ? 'Active-le pour le monde choisi.' : 'Sélectionne un monde prêt pour l’activer.'}`,
      });
    } catch (error) {
      setWorldManagerError((error as Error).message);
    } finally {
      setWorldBusyId(null);
    }
  };

  const handleTogglePack = async (pack: ManagedBedrockPack) => {
    if (!packWorldId) return;
    setWorldBusyId(`pack-${pack.uuid}`);
    setWorldManagerError('');
    try {
      const snapshot = await apiRequest<WorldBedrockPacksSnapshot>(
        `/api/server/worlds/${encodeURIComponent(packWorldId)}/packs/${encodeURIComponent(pack.uuid)}`,
        { method: 'PUT', body: JSON.stringify({ enabled: !pack.active }) },
      );
      setWorldPacks(snapshot.packs);
      pushPanelToast({
        tone: 'success',
        title: pack.active ? 'Pack désactivé' : 'Pack activé',
        description: `« ${pack.name} » a été ${pack.active ? 'retiré de' : 'ajouté à'} la liste de packs de ce monde.`,
      });
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
      <PanelLoginView
        authStatus={authStatus}
        reduceMotion={reduceMotion}
        loginUsername={loginUsername}
        onUsernameChange={setLoginUsername}
        token={token}
        onTokenChange={setToken}
        showToken={showToken}
        onToggleShowToken={() => setShowToken((visible) => !visible)}
        loginBusy={loginBusy}
        loginError={loginError}
        onSubmit={(event) => { void handleLogin(event); }}
      />
    );
  }

  const server = status?.state.server;
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
  const panelRole: PanelRole | null = authStatus?.role ?? null;
  const canOperate = panelRole === 'owner' || panelRole === 'admin' || panelRole === 'operator';
  const canAdmin = panelRole === 'owner' || panelRole === 'admin';
  const activeWorld = activeConfig
    ? worlds.find((world) => world.version === activeConfig.version && world.folder === activeConfig.levelName)
    : undefined;
  const selectedWorld = selectedWorldId ? worlds.find((world) => world.id === selectedWorldId) : undefined;
  const packWorld = packWorldId ? worlds.find((world) => world.id === packWorldId) : undefined;
  const readyPackWorlds = worlds.filter((world) => world.status === 'ready');
  const editingWorld = worldEditId ? worlds.find((world) => world.id === worldEditId) : undefined;
  const selectedVersion = versions.find((version) => version.version === configuration.version);
  const configurationLocked = !canOperate || isPipelineBusy || !server
    || server.status === 'running'
    || server.status === 'starting'
    || server.status === 'stopping'
    || (server.status === 'failed' && server.pid !== null);
  const packImportLocked = !canAdmin || configurationLocked || worldBusyId !== null;
  const packMutationLocked = packImportLocked || !packWorld || packWorld.status !== 'ready';
  const worldsForSelectedVersion = worlds.filter((world) => world.version === configuration.version && world.status === 'ready');
  const hasVersionChange = Boolean(activeConfig && configuration.version !== activeConfig.version);
  const hasWorldChange = selectedWorldId ? selectedWorld?.id !== activeWorld?.id : true;
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
  const startDisabled = !canOperate || isPipelineBusy || !activeConfig || !system?.bedrockBinary.ok || bedrockMayBeRunning || busyAction === 'stop';
  const stopDisabled = !canOperate || isPipelineBusy || busyAction === 'stop' || !bedrockMayBeRunning;
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
          <a className="ncraft-brand" href="#overview" aria-label="Nebula Craft, accueil" translate="no" onClick={(event) => { event.preventDefault(); switchPanel('overview'); }}>
            <motion.span className="brand-mark" whileHover={reduceMotion ? undefined : { scale: 1.04 }}>
              <NebulaBrandMark />
            </motion.span>
            <span className="ncraft-brand__copy">
              <strong className="ncraft-brand__name" translate="no">Nebula Craft</strong>
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
            <span className="panel-role-pill" title={`Compte ${authStatus?.username ?? 'inconnu'} · rôle ${panelRole ?? 'inconnu'}`}>
              <Shield size={14} aria-hidden="true" /> {authStatus?.username ?? 'Compte'} · {panelRole ?? '—'}
            </span>
            <motion.button
              type="button"
              onClick={() => setAboutOpen(true)}
              whileTap={reduceMotion ? undefined : { scale: 0.95 }}
              className="icon-button about-trigger"
            >
              <Info size={17} aria-hidden="true" />
              <span>À propos</span>
            </motion.button>
            <motion.button
              type="button"
              onClick={() => { void handleLogout(); }}
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
          aria-labelledby="mobile-tab-overview"
          tabIndex={0}
          hidden={activeSection !== 'overview'}
        >
          {activeSection === 'overview' && (
            <OverviewPanel
              reduceMotion={reduceMotion}
              animatePanelEntry={animatePanelEntry}
              currentServerStatus={currentServerStatus}
              isPipelineBusy={isPipelineBusy}
              activeConfig={activeConfig}
              activeWorld={activeWorld}
              server={server}
              startDisabled={startDisabled}
              stopDisabled={stopDisabled}
              busyAction={busyAction}
              scheduler={scheduler}
              providerName={providerName}
              tunnelProvider={tunnelProvider}
              tunnelStatus={tunnelStatus}
              activeTunnel={activeTunnel}
              portwarp={portwarp}
              portwarpSetup={portwarpSetup}
              localtonet={localtonet}
              playit={playit}
              playitSetup={playitSetup}
              canOperate={canOperate}
              metricHistory={metricHistory}
              versionEntry={versionEntry}
              onStart={() => { void handleStart(); }}
              onStop={() => { void handleStop(); }}
              onSwitchPanel={switchPanel}
              onCopy={(value, label) => { void handleCopy(value, label); }}
              onPlayitSetup={() => { void handlePlayitSetup(); }}
              onPortwarpRetry={() => { void handlePortwarpRetry(); }}
            />
          )}
        </section>

        <section
          id="panel-deploy"
          className="ncraft-tab-panel"
          role="tabpanel"
          aria-labelledby="mobile-tab-deploy"
          tabIndex={0}
          hidden={activeSection !== 'deploy'}
        >
          {activeSection === 'deploy' && (
            <Suspense fallback={<PanelLoadingFallback label="Chargement du déploiement…" />}>
              <DeployPanel
                reduceMotion={reduceMotion}
                animatePanelEntry={animatePanelEntry}
                canAdmin={canAdmin}
                isExistingDeployment={isExistingDeployment}
                bedrockMayBeRunning={bedrockMayBeRunning}
                configurationLocked={configurationLocked}
                deploymentVersionOptions={deploymentVersionOptions}
                configuration={configuration}
                selectedVersion={selectedVersion}
                versionsCount={versions.length}
                selectedWorldId={selectedWorldId}
                selectedWorld={selectedWorld}
                worldsForSelectedVersion={worldsForSelectedVersion}
                newWorldName={newWorldName}
                isPipelineBusy={isPipelineBusy}
                isEditingWorldSettings={isEditingWorldSettings}
                editingWorld={editingWorld}
                worldBusyId={worldBusyId}
                operationNeedsDeploy={operationNeedsDeploy}
                configurationActionDisabled={configurationActionDisabled}
                configurationActionLabel={configurationActionLabel}
                onDeploySubmit={(event) => { void handleDeploy(event); }}
                onSaveWorldSettings={() => { void handleSaveWorldSettings(); }}
                onSaveConfiguration={() => { void handleSaveConfiguration(); }}
                onChangeField={changeField}
                onChooseNewWorld={chooseNewWorld}
                onChooseWorld={chooseWorld}
                onNewWorldNameChange={(value) => { markConfigTouched(); setNewWorldName(value); }}
                onAddAdminField={addAdminField}
                onSetAdminXuid={setAdminXuid}
                onRemoveAdminField={removeAdminField}
                onCopy={handleCopy}
              />
            </Suspense>
          )}
        </section>

        <section
          id="panel-worlds"
          className="ncraft-tab-panel"
          role="tabpanel"
          aria-labelledby="mobile-tab-worlds"
          tabIndex={0}
          hidden={activeSection !== 'worlds'}
        >
          {activeSection === 'worlds' && (
            <Suspense fallback={<PanelLoadingFallback label="Chargement du gestionnaire de mondes…" />}>
              <WorldsPanel
                reduceMotion={reduceMotion}
                animatePanelEntry={animatePanelEntry}
                canOperate={canOperate}
                canAdmin={canAdmin}
                configurationLocked={configurationLocked}
                configurationVersion={versions.some((version) => version.version === configuration.version) ? configuration.version : ''}
                versionsAvailable={versions.length > 0}
                isValidImportVersion={versions.some((version) => version.version === worldImportVersion)}
                worlds={worlds}
                activeWorld={activeWorld}
                startDisabled={startDisabled}
                worldManagerError={worldManagerError}
                worldVersionOptions={worldVersionOptions}
                worldImportVersion={worldImportVersion}
                worldImportName={worldImportName}
                worldImportFile={worldImportFile}
                worldImportInputRef={worldImportInputRef}
                worldBusyId={worldBusyId}
                renameWorldId={renameWorldId}
                renameWorldValue={renameWorldValue}
                assignWorldVersion={assignWorldVersion}
                worldSwipeNonce={worldSwipeNonce}
                packWorldId={packWorldId}
                packWorld={packWorld}
                readyPackWorlds={readyPackWorlds}
                packImportLocked={packImportLocked}
                packMutationLocked={packMutationLocked}
                worldPackFile={worldPackFile}
                worldPackInputRef={worldPackInputRef}
                worldPackLoading={worldPackLoading}
                worldPacks={worldPacks}
                onRefreshWorlds={() => { void refreshWorlds(); }}
                onSetWorldImportVersion={setWorldImportVersion}
                onSetWorldImportName={setWorldImportName}
                onSelectWorldImportFile={(file) => {
                  setWorldImportFile(file);
                  if (file && !worldImportName) setWorldImportName(file.name.replace(/\.(mcworld|zip)$/i, ''));
                }}
                onImportWorld={() => { void handleImportWorld(); }}
                onChooseNewWorld={chooseNewWorld}
                onChooseWorld={chooseWorld}
                onStartServer={() => { void handleStart(); }}
                onExportWorld={handleExportWorld}
                onStartRenameWorld={(world) => { setRenameWorldId(world.id); setRenameWorldValue(world.name); }}
                onCancelRenameWorld={() => setRenameWorldId(null)}
                onChangeRenameWorldValue={setRenameWorldValue}
                onCommitRenameWorld={(world) => { void handleRenameWorld(world); }}
                onChangeAssignWorldVersion={(worldId, version) => setAssignWorldVersion((current) => ({ ...current, [worldId]: version }))}
                onAssignWorld={(world) => { void handleAssignWorld(world); }}
                onDeleteWorld={handleDeleteWorld}
                onResetWorldSwipe={(worldId) => setWorldSwipeNonce((current) => ({ ...current, [worldId]: (current[worldId] ?? 0) + 1 }))}
                onCopy={handleCopy}
                onSetPackWorldId={setPackWorldId}
                onSelectWorldPackFile={setWorldPackFile}
                onImportPack={() => { void handleImportPack(); }}
                onTogglePack={(pack) => { void handleTogglePack(pack); }}
              />
            </Suspense>
          )}
        </section>

        <section
          id="panel-diagnostics"
          className="ncraft-tab-panel"
          role="tabpanel"
          aria-labelledby="mobile-tab-diagnostics"
          tabIndex={0}
          hidden={activeSection !== 'diagnostics'}
        >
          {activeSection === 'diagnostics' && (
            <Suspense fallback={<PanelLoadingFallback label="Chargement des diagnostics…" />}>
              <DiagnosticsPanel
                reduceMotion={reduceMotion}
                animatePanelEntry={animatePanelEntry}
                canOperate={canOperate}
                chatbot={chatbot}
                chatbotPillStatus={chatbotPillStatus}
                chatbotPillLabel={chatbotPillLabel}
                chatbotBusy={chatbotBusy}
                chatbotFeedback={chatbotFeedback}
                pipeline={pipeline}
                isPipelineBusy={isPipelineBusy}
                currentStepIndex={currentStepIndex}
                system={system}
                serverDirectory={status?.serverDirectory}
                tunnelProvider={tunnelProvider}
                onChatbotLink={() => { void handleChatbotLink(); }}
                onChatbotCancel={() => { void handleChatbotCancel(); }}
                onChatbotUnlink={() => { void handleChatbotUnlink(); }}
                onChatbotUnlinkUndo={() => {
                  setChatbotFeedback('Déliaison annulée.');
                  pushPanelToast({ tone: 'info', title: 'Déliaison annulée', description: 'Le compte Bedrock dédié et ses jetons restent inchangés.' });
                }}
              />
            </Suspense>
          )}
        </section>

        <section
          id="panel-operations"
          className="ncraft-tab-panel"
          role="tabpanel"
          aria-labelledby="mobile-tab-operations"
          tabIndex={0}
          hidden={activeSection !== 'operations'}
        >
          {activeSection === 'operations' && (
            <Suspense fallback={<PanelLoadingFallback label="Chargement des opérations…" />}>
              <OperationsView
                role={panelRole}
                authStatus={authStatus}
                worlds={worlds}
                state={status?.state ?? null}
                system={status?.system ?? null}
                snapshots={status?.snapshots ?? null}
                recovery={status?.recovery ?? null}
                monitoring={status?.monitoring ?? null}
                refreshStatus={refreshStatus}
                onNotify={(tone, title, description) => pushPanelToast({ tone, title, description })}
              />
            </Suspense>
          )}
        </section>

        <section
          id="panel-console"
          className="ncraft-tab-panel"
          role="tabpanel"
          aria-labelledby="mobile-tab-console"
          tabIndex={0}
          hidden={activeSection !== 'console'}
        >
          {activeSection === 'console' && (
            <Suspense fallback={<PanelLoadingFallback label="Chargement de la console…" />}>
              <ConsolePanel
                reduceMotion={reduceMotion}
                animatePanelEntry={animatePanelEntry}
                canOperate={canOperate}
                canAdmin={canAdmin}
                serverRunning={server?.status === 'running'}
                consoleConnected={consoleConnected}
                consoleLogs={consoleLogs}
                consoleError={consoleError}
                command={command}
                logViewportRef={logViewportRef}
                onCommandChange={setCommand}
                onSubmitCommand={handleCommand}
              />
            </Suspense>
          )}
        </section>

        <section
          id="panel-pixel-studio"
          className="ncraft-tab-panel"
          role="tabpanel"
          aria-labelledby="mobile-tab-pixel-studio"
          tabIndex={0}
          hidden={activeSection !== 'pixel-studio'}
        >
          {activeSection === 'pixel-studio' && (canOperate ? (
            <Suspense fallback={<PanelLoadingFallback label="Chargement de Pixel Studio…" />}>
              <PixelStudioView onNotify={(tone, title, description) => pushPanelToast({ tone, title, description })} />
            </Suspense>
          ) : (
            <div className="nether-callout nether-callout--warning" role="status">
              <ShieldCheck size={17} />
              <span>La génération d’images et d’animations est réservée aux comptes operator, admin ou owner.</span>
            </div>
          ))}
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
              aria-label={tab.label}
              aria-controls={`panel-${tab.id}`}
              aria-selected={activeSection === tab.id}
              tabIndex={activeSection === tab.id ? 0 : -1}
              onClick={() => switchPanel(tab.id)}
              onKeyDown={(event) => handleMobileTabKeyDown(event, tab.id)}
            >
              <Icon size={17} aria-hidden="true" />
              <span className="mobile-dock__label" aria-hidden="true">
                <span className="mobile-dock__label-full">{tab.label}</span>
                <span className="mobile-dock__label-compact">{tab.compactLabel}</span>
              </span>
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
