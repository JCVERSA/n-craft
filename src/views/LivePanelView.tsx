import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
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
  ExternalLink,
  Globe,
  Layers,
  Loader2,
  LockKeyhole,
  LogOut,
  Package,
  Play,
  Power,
  RefreshCw,
  Server,
  ShieldCheck,
  Terminal,
  Users,
  Wifi,
  X,
} from 'lucide-react';
import { BedrockMetricsChart } from '../components/BedrockMetricsChart.tsx';
import { NetherCard } from '../components/NetherCard.tsx';
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
  DeployConfiguration,
  PersistentPanelState,
  PipelineStep,
  PlayitSetupSnapshot,
  PortwarpLoginSnapshot,
  ScheduledRestartSnapshot,
  SystemPreflight,
  TunnelProvider,
  VersionEntry,
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
}

type PublicVersion = Omit<VersionEntry, 'downloadUrl'>;

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

export function LivePanelView() {
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  const [activeSection, setActiveSection] = useState('overview');
  const [token, setToken] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [clockNow, setClockNow] = useState(Date.now());
  const [metricHistory, setMetricHistory] = useState<BedrockMetricSample[]>(() => loadMetricHistory(getMetricStorage()));
  const reduceMotion = useReducedMotion();
  const [versions, setVersions] = useState<PublicVersion[]>([]);
  const [configuration, setConfiguration] = useState<DeployConfiguration>(defaultConfiguration);
  const [configTouched, setConfigTouched] = useState(false);
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyAction, setBusyAction] = useState<'deploy' | 'start' | 'stop' | 'playit' | 'portwarp' | 'logout' | null>(null);
  const [consoleLogs, setConsoleLogs] = useState<ConsoleLog[]>([]);
  const [consoleConnected, setConsoleConnected] = useState(false);
  const [command, setCommand] = useState('');
  const [consoleError, setConsoleError] = useState('');
  const socketRef = useRef<WebSocket | null>(null);
  const logViewportRef = useRef<HTMLDivElement>(null);

  const isPipelineBusy = Boolean(status?.deployBusy || status?.state.pipeline.status === 'running' || busyAction === 'deploy' || busyAction === 'start');
  const currentStepIndex = useMemo(
    () => pipelineSteps.findIndex((step) => step.id === status?.state.pipeline.step),
    [status?.state.pipeline.step],
  );

  const refreshStatus = useCallback(async () => {
    try {
      const next = await apiRequest<StatusResponse>('/api/server/status');
      setStatus(next);
      if (next.state.activeConfig && !configTouched) setConfiguration(next.state.activeConfig);
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
    if (!authenticated) return;
    let timer: number | undefined;
    const stopClock = () => {
      if (timer === undefined) return;
      window.clearInterval(timer);
      timer = undefined;
    };
    const startClock = () => {
      if (document.visibilityState !== 'visible' || timer !== undefined) return;
      setClockNow(Date.now());
      timer = window.setInterval(() => setClockNow(Date.now()), 1000);
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
  }, [authenticated]);

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
    if (!authenticated || typeof IntersectionObserver === 'undefined') return;
    const sectionIds = ['overview', 'deploy', 'diagnostics', 'console'];
    const sections = sectionIds.map((id) => document.getElementById(id)).filter((section): section is HTMLElement => Boolean(section));
    if (sections.length === 0) return;
    const visibility = new Map<string, { ratio: number; top: number }>();
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        visibility.set(entry.target.id, {
          ratio: entry.isIntersecting ? entry.intersectionRatio : 0,
          top: entry.boundingClientRect.top,
        });
      });
      const current = [...visibility.entries()]
        .filter(([, value]) => value.ratio > 0)
        .sort((a, b) => b[1].ratio - a[1].ratio || a[1].top - b[1].top)[0]?.[0];
      if (current) setActiveSection(current);
    }, { rootMargin: '-96px 0px -58% 0px', threshold: [0, 0.15, 0.35, 0.6, 1] });
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
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
        ]).then(([catalog, nextStatus]) => {
          if (cancelled) return;
          setVersions(catalog.versions);
          setStatus(nextStatus);
          if (nextStatus.state.activeConfig && !configTouched) {
            setConfiguration(nextStatus.state.activeConfig);
            setConfigTouched(false);
          }
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
  }, [consoleLogs]);

  useEffect(() => {
    if (versions.length > 0 && !configuration.version && !status?.state.activeConfig) {
      setConfiguration((current) => ({ ...current, version: versions[0].version }));
    }
  }, [versions, configuration.version, status?.state.activeConfig]);

  const markConfigTouched = () => {
    setConfigTouched(true);
    setFormError('');
    setNotice('');
  };

  const changeField = <K extends keyof DeployConfiguration>(key: K, value: DeployConfiguration[K]) => {
    markConfigTouched();
    setConfiguration((current) => ({ ...current, [key]: value }));
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
      setAuthenticated(true);
      setAuthStatus((current) => current ? { ...current, authenticated: true } : current);
    } catch (error) {
      setLoginError((error as Error).message);
      setToken('');
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
    if (!isValidForm(configuration)) {
      setFormError('Complète les champs requis, fournis 1 à 3 XUID numériques uniques et confirme l’EULA.');
      return;
    }
    if (status?.system.deployReady === false) {
      setFormError('Déploiement bloqué : les dépendances Linux obligatoires (glibc/libcurl) ne sont pas toutes détectées. Consulte les contrôles système ci-dessous.');
      return;
    }

    const confirmationMessage = [
      `Mettre à jour Bedrock vers ${configuration.version} dans ${status?.serverDirectory ?? 'BEDROCK_SERVER_DIR'} ?`,
      isExistingDeployment
        ? 'Déploiement non destructif : le monde, les sauvegardes, les packs, server.properties et permissions.json existants seront conservés. Seule la version du serveur sera modifiée.'
        : 'Première installation : le dossier existant n’est pas supprimé. Le monde et les fichiers déjà présents seront conservés autant que possible.',
      'Le serveur restera en ligne pendant le téléchargement et l’extraction, puis sera arrêté proprement et redémarré automatiquement. Le tunnel ne sera pas interrompu.',
      status?.system.memoryWarning ? 'Le conteneur est sous le budget mémoire recommandé ; un arrêt OOM est possible.' : '',
      status?.system.diskWarning ? `Espace disque détecté : DATA_DIR ${formatBytes(status.system.dataDiskFreeBytes)} libres / ${formatBytes(status.system.dataDiskRequiredBytes)} estimés${status.system.sharedDiskVolume === false ? ` ; BEDROCK_SERVER_DIR ${formatBytes(status.system.serverDiskFreeBytes)} libres / ${formatBytes(status.system.serverDiskRequiredBytes)} estimés` : status.system.sharedDiskVolume === null ? ' ; volume de BEDROCK_SERVER_DIR incertain' : ' ; volume partagé, archive + extraction incluses'}. Le déploiement reste autorisé, mais peut échouer si le volume est plein.` : '',
      'Confirmer le déploiement non destructif ?',
    ].filter(Boolean).join('\n\n');
    if (!window.confirm(confirmationMessage)) return;

    setBusyAction('deploy');
    try {
      await apiRequest('/api/server/deploy', {
        method: 'POST',
        body: JSON.stringify({ config: configuration }),
      });
      setNotice('Déploiement accepté. Suis chaque étape et son résultat dans la progression ci-dessous.');
      await refreshStatus();
    } catch (error) {
      setFormError((error as Error).message);
    } finally {
      setBusyAction(null);
    }
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
    if (!window.confirm(`Arrêter uniquement bedrock_server ? Le tunnel ${tunnelProvider} restera en fonctionnement.`)) return;
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
        <div className="ncraft-auth-orbit" aria-hidden="true" />
        <motion.div
          className="ncraft-loading-card"
          initial={reduceMotion ? false : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <span className="brand-mark"><Activity size={22} /></span>
          <Loader2 className="spin-soft" size={18} />
          <span>Chargement du panneau…</span>
        </motion.div>
      </main>
    );
  }

  if (!authenticated) {
    return (
      <main className="ncraft-shell ncraft-auth-shell">
        <div className="ncraft-auth-orbit" aria-hidden="true" />
        <motion.section
          className="ncraft-login-card"
          initial={reduceMotion ? false : { opacity: 0, y: 18, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="login-brand-row">
            <span className="brand-mark brand-mark--large"><Activity size={25} /></span>
            <div>
              <p className="nether-eyebrow">BEDROCK CONTROL DECK</p>
              <h1>NEBULA <span>CRAFT</span></h1>
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
            <label className="nether-field" htmlFor="panel-token">
              <span>Jeton du panneau</span>
              <input
                id="panel-token"
                type="password"
                autoComplete="current-password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                disabled={!authStatus?.configured || loginBusy}
                className="nether-input"
                placeholder="PANEL_TOKEN"
              />
            </label>
            {loginError && <p role="alert" className="inline-error">{loginError}</p>}
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
          <p className="login-footer"><ShieldCheck size={14} /> Session protégée · connexion chiffrée</p>
        </motion.section>
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
  const isExistingDeployment = Boolean(activeConfig);
  const uptimeSeconds = server?.status === 'running' && server.startedAt
    ? Math.floor((clockNow - Date.parse(server.startedAt)) / 1000)
    : null;
  const providerName = tunnelProvider === 'portwarp' ? 'Portwarp' : tunnelProvider === 'localtonet' ? 'Localtonet' : 'Playit';
  const selectedVersion = versions.find((version) => version.version === configuration.version);
  const versionEntry = activeConfig?.version
    ? versions.find((version) => version.version === activeConfig.version)
    : undefined;
  const currentServerStatus = server?.status ?? 'stopped';
  const tunnelStatus = activeTunnel?.status ?? 'starting';
  const startDisabled = isPipelineBusy || !activeConfig || !system?.bedrockBinary.ok || server?.status === 'running' || busyAction === 'stop';
  const stopDisabled = isPipelineBusy || busyAction === 'stop' || server?.status !== 'running';

  return (
    <main className="ncraft-shell">
      <a className="skip-link" href="#main-content">Aller au contenu principal</a>
      <div className="ncraft-ambient ncraft-ambient--magma" aria-hidden="true" />
      <div className="ncraft-ambient ncraft-ambient--portal" aria-hidden="true" />
      <div className="ncraft-grid-glow" aria-hidden="true" />

      <header className="ncraft-header">
        <div className="ncraft-header__inner">
          <a className="ncraft-brand" href="#overview" aria-label="Nebula Craft, accueil">
            <motion.span className="brand-mark" whileHover={reduceMotion ? undefined : { rotate: 8, scale: 1.04 }}>
              <Activity size={21} strokeWidth={2.2} />
            </motion.span>
            <span className="ncraft-brand__copy">
              <strong>NEBULA <em>CRAFT</em></strong>
              <small>BEDROCK CONTROL DECK</small>
            </span>
          </a>

          <nav className="ncraft-nav" aria-label="Navigation du panneau">
            <a className={activeSection === 'overview' ? 'is-current' : undefined} href="#overview" aria-current={activeSection === 'overview' ? 'location' : undefined} onClick={() => setActiveSection('overview')}><Server size={15} /> Vue générale</a>
            <a className={activeSection === 'deploy' ? 'is-current' : undefined} href="#deploy" aria-current={activeSection === 'deploy' ? 'location' : undefined} onClick={() => setActiveSection('deploy')}><Package size={15} /> Déploiement</a>
            <a className={activeSection === 'diagnostics' ? 'is-current' : undefined} href="#diagnostics" aria-current={activeSection === 'diagnostics' ? 'location' : undefined} onClick={() => setActiveSection('diagnostics')}><ShieldCheck size={15} /> Diagnostics</a>
            <a className={activeSection === 'console' ? 'is-current' : undefined} href="#console" aria-current={activeSection === 'console' ? 'location' : undefined} onClick={() => setActiveSection('console')}><Terminal size={15} /> Console</a>
          </nav>

          <div className="ncraft-header__actions">
            <StatusPill status={currentServerStatus} />
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

        <section id="overview" className="ncraft-overview-grid">
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
                {activeConfig ? <img src="/assets/minecraft/grass-block.webp" alt="" width="22" height="22" /> : <Globe size={19} />}
              </span>
              <span className="world-capsule__copy">
                <small>MONDE ACTIF</small>
                <strong title={activeConfig?.levelName ?? 'Aucun monde déployé'}>{activeConfig?.levelName ?? 'Aucun monde déployé'}</strong>
              </span>
              <span className="world-capsule__version">
                {activeConfig?.version ? `BDS ${activeConfig.version}` : 'À configurer'}
              </span>
            </div>

            <div className="hero-metrics-grid">
              <MetricTile icon={Users} label="Joueurs" value={`${server?.playersOnline ?? '—'} / ${activeConfig?.maxPlayers ?? '—'}`} detail="connectés / maximum" accent="portal" />
              <MetricTile icon={Clock3} label="Disponibilité" value={formatDuration(uptimeSeconds)} detail={uptimeSeconds === null ? 'serveur hors ligne' : 'depuis le démarrage'} accent="soul" />
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
              <a className="nether-btn nether-btn--quiet" href="#deploy"><Package size={16} /> Mettre à jour <ArrowRight size={14} /></a>
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
          <BedrockMetricsChart samples={metricHistory} now={clockNow} serverStatus={server?.status} />
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
              <div className="empty-state"><Package size={24} /><strong>Aucune version déployée</strong><span>Choisis une version Bedrock vérifiée dans le panneau de déploiement.</span><a href="#deploy">Configurer le serveur <ChevronRight size={14} /></a></div>
            )}
          </NetherCard>
        </section>

        <section className="ncraft-section-heading" aria-label="Gestion du serveur">
          <div><p className="nether-eyebrow">OUTILS DE L’OPÉRATEUR</p><h2>Maintenance & diagnostics</h2></div>
          <span className="section-heading-note"><ShieldCheck size={15} /> Actions reliées aux états du backend</span>
        </section>

        <section className="ncraft-workspace-grid">
          <NetherCard
            id="deploy"
            title="Cartouche de mise à jour"
            eyebrow="DÉPLOIEMENT BEDROCK"
            description="Sélectionne une version réelle du catalogue, puis déploie sans effacer le monde."
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
                    <span>Le monde, les packs, les permissions et les réglages existants sont préservés. Seule la version Bedrock choisie change.</span>
                  </div>
                </div>
              )}

              <div className="cartridge-slot">
                <div className="cartridge-slot__art"><Package size={26} /></div>
                <label className="nether-field cartridge-slot__picker" htmlFor="bedrock-version">
                  <span>Version du serveur <b>requise</b></span>
                  <select id="bedrock-version" value={configuration.version} onChange={(event) => changeField('version', event.target.value)} className="nether-input" required>
                    <option value="">Choisir une version…</option>
                    {versions.map((version) => <option key={version.version} value={version.version}>{version.label} · {version.releaseDate}</option>)}
                  </select>
                </label>
                <div className="cartridge-slot__info">
                  <span className="nether-eyebrow">SÉLECTION</span>
                  <strong>{selectedVersion?.label ?? (configuration.version || 'Aucune version')}</strong>
                  <small>{selectedVersion ? `Sortie · ${selectedVersion.releaseDate}` : 'Catalogue vérifié du panneau'}</small>
                </div>
              </div>
              {versions.length === 0 && <p className="inline-error">Aucun ZIP vérifié disponible dans data/versions.json.</p>}

              <div className="nether-form-grid">
                <label className="nether-field">
                  <span>Nom du serveur</span>
                  <input value={configuration.serverName} maxLength={64} disabled={isExistingDeployment} onChange={(event) => changeField('serverName', event.target.value)} className="nether-input" required />
                </label>
                <label className="nether-field">
                  <span>Nom du monde</span>
                  <input value={configuration.levelName} maxLength={64} disabled={isExistingDeployment} onChange={(event) => changeField('levelName', event.target.value)} className="nether-input" required />
                </label>
                <label className="nether-field">
                  <span>Mode de jeu</span>
                  <select value={configuration.gamemode} disabled={isExistingDeployment} onChange={(event) => changeField('gamemode', event.target.value as DeployConfiguration['gamemode'])} className="nether-input">
                    <option value="survival">Survie</option><option value="creative">Créatif</option><option value="adventure">Aventure</option>
                  </select>
                </label>
                <label className="nether-field">
                  <span>Difficulté</span>
                  <select value={configuration.difficulty} disabled={isExistingDeployment} onChange={(event) => changeField('difficulty', event.target.value as DeployConfiguration['difficulty'])} className="nether-input">
                    <option value="peaceful">Paisible</option><option value="easy">Facile</option><option value="normal">Normale</option><option value="hard">Difficile</option>
                  </select>
                </label>
                <label className="nether-field">
                  <span>Joueurs maximum</span>
                  <input type="number" min={1} step={1} value={configuration.maxPlayers} disabled={isExistingDeployment} onChange={(event) => changeField('maxPlayers', Number(event.target.value))} className="nether-input" required />
                </label>
                <label className="nether-field">
                  <span>Seed <small>optionnelle · vide = aléatoire</small></span>
                  <input value={configuration.seed} maxLength={80} disabled={isExistingDeployment} onChange={(event) => changeField('seed', event.target.value)} className="nether-input" />
                </label>
                <label className="nether-field">
                  <span>Distance de vue <small>chunks</small></span>
                  <input type="number" min={1} max={96} step={1} value={configuration.viewDistance} disabled={isExistingDeployment} onChange={(event) => changeField('viewDistance', Number(event.target.value))} className="nether-input" />
                </label>
              </div>

              <div className="admin-xuid-box">
                <div className="admin-xuid-box__header">
                  <div><strong>Administrateurs Bedrock</strong><small>1 à 3 XUID numériques uniques · aucun gamertag</small></div>
                  <motion.button type="button" onClick={addAdminField} disabled={isExistingDeployment || configuration.adminXuids.length >= 3} whileTap={reduceMotion ? undefined : { scale: 0.95 }} className="nether-btn nether-btn--tiny nether-btn--quiet">
                    <Users size={14} /> Ajouter
                  </motion.button>
                </div>
                <div className="admin-xuid-list">
                  {configuration.adminXuids.map((xuid, index) => (
                    <div key={index} className="admin-xuid-row">
                      <span className="admin-xuid-row__number">{String(index + 1).padStart(2, '0')}</span>
                      <input aria-label={`XUID administrateur ${index + 1}`} inputMode="numeric" autoComplete="off" value={xuid} disabled={isExistingDeployment} onChange={(event) => setAdminXuid(index, event.target.value)} className="nether-input" placeholder="Ex. 2535412894129841" required />
                      {configuration.adminXuids.length > 1 && <button type="button" onClick={() => removeAdminField(index)} disabled={isExistingDeployment} className="icon-button icon-button--danger" aria-label={`Retirer le XUID ${index + 1}`}><X size={16} /></button>}
                    </div>
                  ))}
                </div>
                {configuration.adminXuids.some((xuid) => xuid.length > 0 && !/^\d{1,20}$/.test(xuid)) && <p className="inline-error">Le XUID doit contenir uniquement des chiffres, sans espace.</p>}
                {configuration.adminXuids.every((xuid) => xuid.length > 0) && new Set(configuration.adminXuids).size !== configuration.adminXuids.length && <p className="inline-error">Chaque XUID administrateur doit être unique.</p>}
              </div>

              <div className="deploy-options-grid">
                <label className="nether-check-card">
                  <input type="checkbox" checked={configuration.allowCheats} disabled={isExistingDeployment} onChange={(event) => changeField('allowCheats', event.target.checked)} />
                  <span className="nether-check-card__box"><Check size={13} /></span>
                  <span><strong>Autoriser les commandes</strong><small>Cheats et commandes de jeu</small></span>
                </label>
                <div className="security-badges">
                  <span><LockKeyhole size={13} /> Auth Bedrock</span>
                  <span><Wifi size={13} /> UDP 19132</span>
                  <span><ShieldCheck size={13} /> Allow-list off</span>
                </div>
              </div>

              <label className="eula-card">
                <input type="checkbox" checked={configuration.eulaAccepted} disabled={isExistingDeployment} onChange={(event) => changeField('eulaAccepted', event.target.checked)} />
                <span className="nether-check-card__box"><Check size={13} /></span>
                <span>J’ai lu et j’accepte l’<a href="https://www.minecraft.net/eula" target="_blank" rel="noreferrer">EULA Minecraft</a>. Si le binaire affiche un prompt connu, le backend y répondra automatiquement; aucun fichier EULA non vérifié ne sera inventé.</span>
              </label>

              <motion.button
                type="submit"
                disabled={isPipelineBusy || !isValidForm(configuration) || versions.length === 0 || system?.deployReady === false}
                whileTap={reduceMotion ? undefined : { scale: 0.99 }}
                className="nether-btn nether-btn--primary nether-btn--wide deploy-submit"
              >
                {isPipelineBusy ? <Loader2 className="spin-soft" size={18} /> : <ArrowRight size={18} />}
                {isPipelineBusy ? `Déploiement : ${statusLabel(pipeline?.step ?? 'preflight')}` : isExistingDeployment ? 'Mettre à jour & redémarrer' : 'Installer & démarrer'}
              </motion.button>
            </form>
          </NetherCard>

          <aside className="ncraft-operations-stack">
            <NetherCard
              id="diagnostics"
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
        </section>

        <NetherCard
          id="console"
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

        <footer className="ncraft-footer">
          <span><Activity size={14} /> Panel mono-instance · pas de Docker imbriqué · aucune base de données</span>
          <span>{system?.checkedAt ? `Dernier précontrôle · ${new Date(system.checkedAt).toLocaleTimeString('fr-FR')}` : 'Précontrôle en attente'}</span>
        </footer>
      </div>

      <nav className="mobile-dock" aria-label="Navigation rapide">
        <a href="#overview" aria-current={activeSection === 'overview' ? 'location' : undefined} onClick={() => setActiveSection('overview')}><Server size={17} /><span>Accueil</span></a>
        <a href="#deploy" aria-current={activeSection === 'deploy' ? 'location' : undefined} onClick={() => setActiveSection('deploy')}><Package size={17} /><span>Déployer</span></a>
        <a href="#diagnostics" aria-current={activeSection === 'diagnostics' ? 'location' : undefined} onClick={() => setActiveSection('diagnostics')}><ShieldCheck size={17} /><span>État</span></a>
        <a href="#console" aria-current={activeSection === 'console' ? 'location' : undefined} onClick={() => setActiveSection('console')}><Terminal size={17} /><span>Console</span></a>
      </nav>
    </main>
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

function MetricTile({
  icon: Icon,
  label,
  value,
  detail,
  accent,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
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
