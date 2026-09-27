import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type {
  AuthStatus,
  ConsoleLog,
  DeployConfiguration,
  PersistentPanelState,
  PipelineStep,
  PlayitSetupSnapshot,
  SystemPreflight,
  VersionEntry,
} from '../types/backend.ts';

interface StatusResponse {
  state: PersistentPanelState;
  playitSetup: PlayitSetupSnapshot;
  system: SystemPreflight;
  serverDirectory: string;
  deployBusy: boolean;
}

type PublicVersion = Omit<VersionEntry, 'downloadUrl'>;

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
  { id: 'stopping', label: 'Arrêt de Bedrock' },
  { id: 'wiping', label: 'Wipe intégral du serveur' },
  { id: 'downloading', label: 'Téléchargement du ZIP' },
  { id: 'extracting', label: 'Extraction sécurisée' },
  { id: 'writing_config', label: 'Écriture des configurations' },
  { id: 'accepting_eula', label: 'EULA (prompt détecté uniquement)' },
  { id: 'starting', label: 'Démarrage et contrôle' },
  { id: 'running', label: 'Serveur en ligne' },
];

function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'inconnu';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} Go`;
  return `${(bytes / 1024 ** 2).toFixed(0)} Mio`;
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
  const [token, setToken] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [versions, setVersions] = useState<PublicVersion[]>([]);
  const [configuration, setConfiguration] = useState<DeployConfiguration>(defaultConfiguration);
  const [configTouched, setConfigTouched] = useState(false);
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyAction, setBusyAction] = useState<'deploy' | 'start' | 'stop' | 'playit' | 'logout' | null>(null);
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
    let cancelled = false;
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
    const interval = window.setInterval(() => { void refreshStatus(); }, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
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

    const destructiveMessage = [
      `ATTENTION : chaque Deploy efface entièrement ${status?.serverDirectory ?? 'BEDROCK_SERVER_DIR'} (monde, sauvegardes, fichiers et configuration), même si tu redéploies la même version.`,
      status?.system.memoryWarning ? 'Le conteneur est sous le budget mémoire recommandé ; un arrêt OOM est possible.' : '',
      status?.system.diskWarning ? `Espace disque détecté : DATA_DIR ${formatBytes(status.system.dataDiskFreeBytes)} libres / ${formatBytes(status.system.dataDiskRequiredBytes)} estimés${status.system.sharedDiskVolume === false ? ` ; BEDROCK_SERVER_DIR ${formatBytes(status.system.serverDiskFreeBytes)} libres / ${formatBytes(status.system.serverDiskRequiredBytes)} estimés` : status.system.sharedDiskVolume === null ? ' ; volume de BEDROCK_SERVER_DIR incertain' : ' ; volume partagé, archive + extraction incluses'}. Le déploiement reste autorisé, mais peut échouer si le volume est plein.` : '',
      'Confirmer le wipe et le nouveau déploiement ?',
    ].filter(Boolean).join('\n\n');
    if (!window.confirm(destructiveMessage)) return;

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
    if (!window.confirm('Arrêter uniquement bedrock_server ? Playit restera en fonctionnement.')) return;
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

  if (authLoading) {
    return <div className="min-h-screen bg-[#131314] flex items-center justify-center text-[#97d85d] font-jb">Chargement du panneau…</div>;
  }

  if (!authenticated) {
    return (
      <main className="min-h-screen bg-[#131314] text-[#e4e2e2] font-space flex items-center justify-center p-4">
        <section className="w-full max-w-lg mc-bevel bg-[#1b1c1c] p-4 sm:p-6 shadow-2xl">
          <div className="flex items-center gap-3 border-b-2 border-[#0e0e0e] pb-4 mb-4">
            <div className="w-12 h-12 mc-inset bg-[#0e0e0e] flex items-center justify-center text-[#97d85d] text-2xl">✦</div>
            <div>
              <p className="font-pixel text-sm sm:text-base text-[#dfc740] pixel-shadow-gold">NEBULA CRAFT</p>
              <p className="font-jb text-xs text-[#c2c9b5] mt-2">Bedrock Dedicated Server · Panel privé</p>
            </div>
          </div>
          <h1 className="font-silk text-lg text-white mb-2">Accès opérateur</h1>
          <p className="font-jb text-xs leading-6 text-[#c2c9b5] mb-5">Entre le jeton du panel. Il sera échangé contre un cookie de session HttpOnly et ne sera jamais stocké dans le navigateur.</p>
          {!authStatus?.configured && (
            <div role="alert" className="mc-inset bg-[#311719] border-l-4 border-[#ff8782] p-3 mb-4 font-jb text-xs text-[#ffb3ae] leading-5">
              PANEL_TOKEN n’est pas configuré dans l’environnement du conteneur. Définis-le, puis redémarre le panel.
            </div>
          )}
          <form onSubmit={handleLogin} className="flex flex-col gap-3">
            <label className="font-jb text-xs text-[#dfc740]" htmlFor="panel-token">JETON PANEL</label>
            <input
              id="panel-token"
              type="password"
              autoComplete="current-password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              disabled={!authStatus?.configured || loginBusy}
              className="mc-inset bg-[#0e0e0e] p-3 font-mono text-sm text-white outline-none focus:border-[#97d85d] disabled:opacity-50"
              placeholder="PANEL_TOKEN"
            />
            {loginError && <p role="alert" className="font-jb text-xs text-[#ff8782]">{loginError}</p>}
            <button disabled={!authStatus?.configured || loginBusy || !token} className="mc-bevel-green bg-[#97d85d] text-[#1b3700] p-3 font-pixel text-[10px] font-bold disabled:cursor-not-allowed disabled:opacity-40">
              {loginBusy ? 'VÉRIFICATION…' : 'OUVRIR LE PANNEAU'}
            </button>
          </form>
        </section>
      </main>
    );
  }

  const server = status?.state.server;
  const playit = status?.state.playit;
  const playitSetup = status?.playitSetup;
  const system = status?.system;
  const pipeline = status?.state.pipeline;

  return (
    <main className="min-h-screen bg-[#131314] text-[#e4e2e2] font-space">
      <header className="sticky top-0 z-40 border-b-2 border-[#0e0e0e] bg-[#1b1c1c] shadow-xl">
        <div className="mx-auto flex max-w-[1500px] items-center justify-between gap-3 px-3 py-3 sm:px-6">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 mc-inset bg-[#0e0e0e] flex items-center justify-center text-[#97d85d] text-xl">✦</div>
            <div className="min-w-0">
              <h1 className="font-pixel text-xs sm:text-sm text-[#dfc740] pixel-shadow-gold">NEBULA CRAFT <span className="text-[#97d85d]">BEDROCK</span></h1>
              <p className="font-jb text-[10px] text-[#c2c9b5] mt-1">INSTANCE UNIQUE · PORT UDP 19132</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden sm:inline-flex mc-inset bg-[#0e0e0e] px-2 py-1 font-jb text-[10px] text-[#97d85d]">SESSION PRIVÉE</span>
            <button onClick={() => void handleLogout()} disabled={busyAction === 'logout'} className="mc-stone-btn bg-[#2a2a2a] px-3 py-2 font-jb text-xs text-white hover:text-[#ff8782] disabled:opacity-50">Déconnexion</button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1500px] p-3 sm:p-5 flex flex-col gap-4 pb-12">
        {(notice || formError) && (
          <div role="status" className={`mc-inset p-3 font-jb text-xs leading-5 ${formError ? 'bg-[#311719] text-[#ffb3ae]' : 'bg-[#20281b] text-[#c7ef9c]'}`}>
            {formError || notice}
            <button className="float-right text-white" aria-label="Fermer le message" onClick={() => { setNotice(''); setFormError(''); }}>×</button>
          </div>
        )}

        <section className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <article className="mc-bevel bg-[#1b1c1c] p-4">
            <p className="font-jb text-[10px] text-[#8c9380]">BEDROCK DEDICATED SERVER</p>
            <div className="mt-2 flex items-center gap-2">
              <span className={`h-3 w-3 ${server?.status === 'running' ? 'bg-[#97d85d]' : server?.status === 'failed' ? 'bg-[#ff8782]' : 'bg-[#dfc740]'} mc-bevel`} />
              <strong className={`font-pixel text-xs ${server?.status === 'running' ? 'text-[#97d85d]' : server?.status === 'failed' ? 'text-[#ff8782]' : 'text-[#dfc740]'}`}>
                {statusLabel(server?.status ?? 'stopped')}
              </strong>
            </div>
            <p className="mt-3 font-jb text-[11px] text-[#c2c9b5]">{status?.state.activeConfig ? `${status.state.activeConfig.version} · ${status.state.activeConfig.levelName}` : 'Aucun déploiement actif'}</p>
            {server?.error && <p className="mt-2 break-words font-jb text-[10px] text-[#ff8782]">{server.error}</p>}
          </article>

          <article className="mc-bevel bg-[#1b1c1c] p-4">
            <p className="font-jb text-[10px] text-[#8c9380]">ADRESSE PUBLIQUE PLAYIT</p>
            {playit?.address ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="select-all break-all font-jb text-sm font-bold text-[#dfc740]">{playit.address}</span>
                <button type="button" onClick={() => void navigator.clipboard?.writeText(playit.address ?? '')} className="mc-stone-btn bg-[#2a2a2a] px-2 py-1 font-jb text-[10px] text-white">Copier</button>
              </div>
            ) : <p className="mt-2 font-jb text-xs text-[#dfc740]">{statusLabel(playit?.status ?? 'starting')}</p>}
            <p className="mt-3 font-jb text-[11px] text-[#c2c9b5]">Tunnel indépendant · destination locale fixe : <strong className="text-white">19132/UDP</strong></p>
            {playitSetup?.claimUrl && (
              <a href={playitSetup.claimUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex mc-bevel-green bg-[#97d85d] px-3 py-2 font-jb text-[10px] font-bold text-[#1b3700]">
                OUVRIR LE LIEN DE CLAIM PLAYIT
              </a>
            )}
            {playitSetup?.phase === 'configured' && !playit?.address && (
              <p className="mt-2 font-jb text-[10px] leading-4 text-[#c2c9b5]">Agent approuvé. Dans ton compte Playit, crée un tunnel Minecraft Bedrock en UDP ; son adresse apparaîtra ici automatiquement.</p>
            )}
            {(playitSetup?.phase === 'waiting_for_secret' || playitSetup?.phase === 'starting') && !playitSetup.claimUrl && (
              <p className="mt-2 font-jb text-[10px] leading-4 text-[#c2c9b5]">Préparation du lien de claim… Le panneau le garde ici, sans le placer dans les logs.</p>
            )}
            {playitSetup?.error && <p className="mt-2 break-words font-jb text-[10px] text-[#ffb3ae]">{playitSetup.error}</p>}
            {playit?.error && <p className="mt-2 break-words font-jb text-[10px] text-[#ffb3ae]">{playit.error}</p>}
            {(playitSetup?.phase === 'failed' || (playitSetup?.phase === 'waiting_for_secret' && !playitSetup.claimUrl)) && (
              <button type="button" onClick={() => void handlePlayitSetup()} disabled={busyAction === 'playit'} className="mt-3 mc-stone-btn bg-[#2a2a2a] px-3 py-2 font-jb text-[10px] text-white disabled:opacity-40">
                {busyAction === 'playit' ? 'DÉMARRAGE…' : 'RÉESSAYER LE CLAIM'}
              </button>
            )}
          </article>

          <article className="mc-bevel bg-[#1b1c1c] p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-jb text-[10px] text-[#8c9380]">PIPELINE DE DÉPLOIEMENT</p>
                <strong className={`mt-2 block font-pixel text-[10px] ${pipeline?.status === 'failed' ? 'text-[#ff8782]' : isPipelineBusy ? 'text-[#dfc740]' : 'text-[#97d85d]'}`}>
                  {pipeline?.status === 'failed' ? 'ÉCHEC' : isPipelineBusy ? statusLabel(pipeline?.step ?? 'preflight') : pipeline?.step === 'running' ? 'DÉPLOIEMENT TERMINÉ' : 'PRÊT'}
                </strong>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => void handleStart()} disabled={isPipelineBusy || !status?.state.activeConfig || !system?.bedrockBinary.ok || server?.status === 'running'} className="mc-bevel-green bg-[#97d85d] px-3 py-2 font-jb text-[10px] font-bold text-[#1b3700] disabled:cursor-not-allowed disabled:opacity-40">
                  {busyAction === 'start' ? 'DÉMARRAGE…' : 'START'}
                </button>
                <button type="button" onClick={() => void handleStop()} disabled={isPipelineBusy || busyAction === 'stop' || server?.status !== 'running'} className="mc-bevel-red bg-[#93000a] px-3 py-2 font-jb text-[10px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-40">
                  {busyAction === 'stop' ? 'ARRÊT…' : 'STOP'}
                </button>
              </div>
            </div>
            <p className="mt-3 font-jb text-[11px] text-[#c2c9b5]">Playit n’est pas arrêté par STOP ni par Deploy.</p>
          </article>
        </section>

        <section className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.9fr)]">
          <form onSubmit={handleDeploy} className="mc-bevel bg-[#1b1c1c] p-3 sm:p-5 flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-[#0e0e0e] pb-3">
              <div>
                <h2 className="font-silk text-base text-[#dfc740]">Configurer & déployer</h2>
                <p className="mt-1 font-jb text-[10px] text-[#c2c9b5]">Deploy repart de zéro et efface sans sauvegarde le dossier du serveur.</p>
              </div>
              <span className="mc-inset bg-[#0e0e0e] px-2 py-1 font-jb text-[10px] text-[#dfc740]">TUNNEL BEDROCK · UDP 19132 FIXE</span>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 font-jb text-[11px] text-[#c2c9b5]">
                Version <span className="text-[#ff8782]">requise</span>
                <select value={configuration.version} onChange={(event) => changeField('version', event.target.value)} className="mc-inset bg-[#0e0e0e] p-2.5 text-sm text-white outline-none focus:border-[#97d85d]" required>
                  <option value="">Choisir une version…</option>
                  {versions.map((version) => <option key={version.version} value={version.version}>{version.label} · {version.releaseDate}</option>)}
                </select>
                {versions.length === 0 && <span className="text-[10px] text-[#ffb3ae]">Aucun ZIP vérifié dans data/versions.json.</span>}
              </label>
              <label className="flex flex-col gap-1 font-jb text-[11px] text-[#c2c9b5]">
                Nom du serveur
                <input value={configuration.serverName} maxLength={64} onChange={(event) => changeField('serverName', event.target.value)} className="mc-inset bg-[#0e0e0e] p-2.5 text-sm text-white outline-none focus:border-[#97d85d]" required />
              </label>
              <label className="flex flex-col gap-1 font-jb text-[11px] text-[#c2c9b5]">
                Nom du monde
                <input value={configuration.levelName} maxLength={64} onChange={(event) => changeField('levelName', event.target.value)} className="mc-inset bg-[#0e0e0e] p-2.5 text-sm text-white outline-none focus:border-[#97d85d]" required />
              </label>
              <label className="flex flex-col gap-1 font-jb text-[11px] text-[#c2c9b5]">
                Mode de jeu
                <select value={configuration.gamemode} onChange={(event) => changeField('gamemode', event.target.value as DeployConfiguration['gamemode'])} className="mc-inset bg-[#0e0e0e] p-2.5 text-sm text-white outline-none">
                  <option value="survival">Survie</option><option value="creative">Créatif</option><option value="adventure">Aventure</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 font-jb text-[11px] text-[#c2c9b5]">
                Difficulté
                <select value={configuration.difficulty} onChange={(event) => changeField('difficulty', event.target.value as DeployConfiguration['difficulty'])} className="mc-inset bg-[#0e0e0e] p-2.5 text-sm text-white outline-none">
                  <option value="peaceful">Paisible</option><option value="easy">Facile</option><option value="normal">Normale</option><option value="hard">Difficile</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 font-jb text-[11px] text-[#c2c9b5]">
                Joueurs max
                <input type="number" min={1} step={1} value={configuration.maxPlayers} onChange={(event) => changeField('maxPlayers', Number(event.target.value))} className="mc-inset bg-[#0e0e0e] p-2.5 text-sm text-white outline-none" required />
              </label>
              <label className="flex flex-col gap-1 font-jb text-[11px] text-[#c2c9b5]">
                Seed <span className="text-[#8c9380]">optionnelle · vide = aléatoire</span>
                <input value={configuration.seed} maxLength={80} onChange={(event) => changeField('seed', event.target.value)} className="mc-inset bg-[#0e0e0e] p-2.5 text-sm text-white outline-none" />
              </label>
              <label className="flex flex-col gap-1 font-jb text-[11px] text-[#c2c9b5]">
                Distance de vue
                <input type="number" min={1} max={96} step={1} value={configuration.viewDistance} onChange={(event) => changeField('viewDistance', Number(event.target.value))} className="mc-inset bg-[#0e0e0e] p-2.5 text-sm text-white outline-none" />
              </label>
            </div>

            <div className="mc-inset bg-[#0e0e0e] p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div>
                  <h3 className="font-jb text-xs font-bold text-[#dfc740]">XUID administrateur(s)</h3>
                  <p className="mt-1 font-jb text-[10px] text-[#8c9380]">1 à 3 identifiants numériques uniquement ; aucun gamertag.</p>
                </div>
                <button type="button" onClick={addAdminField} disabled={configuration.adminXuids.length >= 3} className="mc-stone-btn bg-[#2a2a2a] px-2 py-1 font-jb text-[10px] text-white disabled:opacity-40">+ Ajouter</button>
              </div>
              <div className="flex flex-col gap-2">
                {configuration.adminXuids.map((xuid, index) => (
                  <div key={index} className="flex gap-2">
                    <input aria-label={`XUID administrateur ${index + 1}`} inputMode="numeric" autoComplete="off" value={xuid} onChange={(event) => setAdminXuid(index, event.target.value)} className="mc-inset min-w-0 flex-1 bg-[#161717] p-2 font-mono text-sm text-white outline-none focus:border-[#97d85d]" placeholder="Ex. 2535412894129841" required />
                    {configuration.adminXuids.length > 1 && <button type="button" onClick={() => removeAdminField(index)} className="mc-stone-btn bg-[#2a2a2a] px-3 font-jb text-xs text-[#ffb3ae]" aria-label={`Retirer le XUID ${index + 1}`}>×</button>}
                  </div>
                ))}
              </div>
              {configuration.adminXuids.some((xuid) => xuid.length > 0 && !/^\d{1,20}$/.test(xuid)) && <p className="mt-2 font-jb text-[10px] text-[#ff8782]">Le XUID doit contenir uniquement des chiffres, sans espace.</p>}
              {configuration.adminXuids.every((xuid) => xuid.length > 0) && new Set(configuration.adminXuids).size !== configuration.adminXuids.length && <p className="mt-2 font-jb text-[10px] text-[#ff8782]">Chaque XUID administrateur doit être unique.</p>}
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="mc-inset flex cursor-pointer items-center gap-3 bg-[#0e0e0e] p-3 font-jb text-xs text-[#c2c9b5]">
                <input type="checkbox" checked={configuration.allowCheats} onChange={(event) => changeField('allowCheats', event.target.checked)} className="h-4 w-4 accent-[#97d85d]" />
                Autoriser les commandes/cheats
              </label>
              <div className="mc-inset flex flex-wrap items-center gap-2 bg-[#0e0e0e] p-3 font-jb text-[10px] text-[#dfc740]">
                <span className="rounded bg-[#2a2a2a] px-2 py-1">online-mode=false</span>
                <span className="rounded bg-[#2a2a2a] px-2 py-1">allow-list=false</span>
                <span className="rounded bg-[#2a2a2a] px-2 py-1">19132/UDP</span>
              </div>
            </div>

            <label className="mc-inset flex cursor-pointer items-start gap-3 bg-[#161717] p-3 font-jb text-[11px] leading-5 text-[#c2c9b5]">
              <input type="checkbox" checked={configuration.eulaAccepted} onChange={(event) => changeField('eulaAccepted', event.target.checked)} className="mt-1 h-4 w-4 shrink-0 accent-[#97d85d]" />
              <span>J’ai lu et j’accepte l’<a href="https://www.minecraft.net/eula" target="_blank" rel="noreferrer" className="text-[#dfc740] underline">EULA Minecraft</a>. Si le binaire affiche un prompt EULA reconnu, le backend répondra automatiquement « y ». Aucun fichier EULA non vérifié ne sera inventé.</span>
            </label>

            <button type="submit" disabled={isPipelineBusy || !isValidForm(configuration) || versions.length === 0 || system?.deployReady === false} className="mc-bevel-gold bg-[#dfc740] p-3 font-pixel text-[10px] font-bold text-[#393000] hover:bg-[#fde35a] disabled:cursor-not-allowed disabled:opacity-40">
              {isPipelineBusy ? `DÉPLOIEMENT : ${statusLabel(pipeline?.step ?? 'preflight')}` : 'WIPE COMPLET & DEPLOY'}
            </button>
          </form>

          <div className="flex flex-col gap-4">
            <section className="mc-bevel bg-[#1b1c1c] p-3 sm:p-5">
              <div className="mb-3 flex items-center justify-between gap-2 border-b-2 border-[#0e0e0e] pb-3">
                <div>
                  <h2 className="font-silk text-base text-[#dfc740]">État du pipeline</h2>
                  <p className="mt-1 font-jb text-[10px] text-[#8c9380]">Chaque transition vient du backend.</p>
                </div>
                <span className={`font-pixel text-[9px] ${pipeline?.status === 'failed' ? 'text-[#ff8782]' : isPipelineBusy ? 'text-[#dfc740]' : 'text-[#97d85d]'}`}>
                  {pipeline?.status === 'failed' ? 'FAILED' : isPipelineBusy ? 'RUNNING' : pipeline?.step === 'running' ? 'DONE' : 'IDLE'}
                </span>
              </div>
              <ol className="flex flex-col gap-2">
                {pipelineSteps.map((step, index) => {
                  const done = (pipeline?.status !== 'failed' && pipeline?.step === 'running') || (currentStepIndex >= 0 && index < currentStepIndex);
                  const active = isPipelineBusy && pipeline?.step === step.id;
                  const failed = pipeline?.status === 'failed' && index === currentStepIndex;
                  return (
                    <li key={step.id} className={`mc-inset flex items-center gap-3 bg-[#0e0e0e] px-2.5 py-2 font-jb text-[10px] ${failed ? 'text-[#ff8782]' : active ? 'text-[#dfc740]' : done ? 'text-[#97d85d]' : 'text-[#777d71]'}`}>
                      <span className="w-6 shrink-0 font-bold">{failed ? '×' : done ? '✓' : active ? '…' : String(index + 1).padStart(2, '0')}</span>
                      <span>{step.label}</span>
                      {active && <span className="ml-auto animate-pulse">EN COURS</span>}
                    </li>
                  );
                })}
              </ol>
              {pipeline?.error && <div role="alert" className="mt-3 mc-inset bg-[#311719] p-3 font-jb text-[11px] leading-5 text-[#ffb3ae]">{pipeline.error}</div>}
            </section>

            <section className="mc-bevel bg-[#1b1c1c] p-3 sm:p-5">
              <div className="mb-3 border-b-2 border-[#0e0e0e] pb-3">
                <h2 className="font-silk text-base text-[#dfc740]">Précontrôle du conteneur</h2>
                <p className="mt-1 break-all font-jb text-[10px] text-[#8c9380]">Mesures dans le conteneur du panel, pas sur l’hôte Docker. Cible du Wipe : {status?.serverDirectory ?? 'en attente du statut'}.</p>
              </div>
              <div className="flex flex-col gap-2 font-jb text-[10px]">
                <CheckRow label={`Linux x64 · Node ${system?.nodeVersion ?? '…'}`} ok={system ? system.platform === 'linux' && system.arch === 'x64' : null} />
                <CheckRow label={`glibc ${system?.glibcVersion ?? 'non détectée'} (minimum visé 2.29)`} ok={system ? system.glibc.ok : null} detail={system?.glibc.detail} />
                <CheckRow label="libcurl.so.4" ok={system ? system.libcurl.ok : null} detail={system?.libcurl.detail} />
                <CheckRow label={`Mémoire allouée : ${formatBytes(system?.memoryLimitBytes ?? null)} · cible 4 Go`} ok={system ? !system.memoryWarning : null} detail={system?.memoryWarning ? 'Avertissement uniquement : le test reste autorisé, mais un OOM est possible.' : undefined} />
                <CheckRow label={`DATA_DIR : ${formatBytes(system?.dataDiskFreeBytes ?? null)} libres · ${formatBytes(system?.dataDiskRequiredBytes ?? null)} estimés`} ok={system ? !system.diskWarning : null} detail={system?.sharedDiskVolume ? 'Même volume que BEDROCK_SERVER_DIR : l’estimation inclut archive + extraction.' : undefined} />
                {system?.sharedDiskVolume === false && <CheckRow label={`BEDROCK_SERVER_DIR : ${formatBytes(system.serverDiskFreeBytes)} libres · ${formatBytes(system.serverDiskRequiredBytes)} estimés`} ok={!system.diskWarning} />}
                {system && system.sharedDiskVolume === null && <CheckRow label={`BEDROCK_SERVER_DIR : ${formatBytes(system.serverDiskFreeBytes)} libres · estimation du volume incertaine`} ok={!system.diskWarning} />}
                <CheckRow label="Daemon Playit (playitd) dans PATH" ok={system ? system.playitBinary.ok : null} detail={system?.playitBinary.detail} />
                <CheckRow label="CLI Playit (claim) dans PATH" ok={system ? system.playitCliBinary.ok : null} detail={system?.playitCliBinary.detail} />
              </div>
              {system?.warnings.map((warning) => <p key={warning} className="mt-2 font-jb text-[10px] leading-4 text-[#dfc740]">⚠ {warning}</p>)}
            </section>

            <section className="mc-bevel bg-[#2a2114] p-3 sm:p-4">
              <h2 className="font-jb text-xs font-bold text-[#dfc740]">Vérifications Bedrock non clôturées</h2>
              <ul className="mt-2 list-disc pl-4 font-jb text-[10px] leading-5 text-[#d6cda8]">
                <li>EULA : le format réel doit être confirmé avec le binaire téléchargé ; le statut restera « non vérifié » si aucun prompt connu n’apparaît.</li>
                <li>Avec online-mode=false, la persistance des opérateurs/XUID après un second déploiement n’a pas été testée. La décision n’est pas modifiée automatiquement.</li>
              </ul>
            </section>
          </div>
        </section>

        <section className="mc-bevel bg-[#1b1c1c] p-3 sm:p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b-2 border-[#0e0e0e] pb-3">
            <div>
              <h2 className="font-silk text-base text-[#97d85d]">Console Bedrock</h2>
              <p className="mt-1 font-jb text-[10px] text-[#8c9380]">stdin/stdout du processus · WebSocket authentifié par cookie de session</p>
            </div>
            <span className={`font-jb text-[10px] ${consoleConnected ? 'text-[#97d85d]' : 'text-[#dfc740]'}`}>{consoleConnected ? '● WS CONNECTÉ' : '○ WS RECONNEXION'}</span>
          </div>
          <div ref={logViewportRef} className="crt-screen h-72 overflow-y-auto mc-inset p-3 font-jb text-[11px] leading-5">
            {consoleLogs.length === 0 && <p className="text-[#8c9380]">Aucun log Bedrock reçu. Le serveur est peut-être arrêté.</p>}
            {consoleLogs.map((line) => <div key={line.id} className={`break-all ${line.level === 'error' ? 'text-[#ff8782]' : line.level === 'warn' ? 'text-[#dfc740]' : line.level === 'success' ? 'text-[#97d85d]' : line.level === 'exec' ? 'text-[#dfc740]' : 'text-[#c2c9b5]'}`}>
              <span className="text-[#777d71]">[{new Date(line.timestamp).toLocaleTimeString()}]</span> <span className="text-[#dfc740]">[{line.tag}]</span> {line.message}
            </div>)}
          </div>
          {consoleError && <p role="alert" className="mt-2 font-jb text-xs text-[#ff8782]">{consoleError}</p>}
          <form onSubmit={handleCommand} className="mt-3 flex gap-2">
            <input value={command} onChange={(event) => setCommand(event.target.value)} maxLength={1000} disabled={server?.status !== 'running'} className="mc-inset min-w-0 flex-1 bg-[#0e0e0e] px-3 py-2 font-jb text-xs text-white outline-none focus:border-[#97d85d] disabled:opacity-50" placeholder={server?.status === 'running' ? 'Commande Bedrock (sans / requis)' : 'Le serveur doit être en ligne pour envoyer une commande'} />
            <button type="submit" disabled={server?.status !== 'running' || !command.trim()} className="mc-bevel-green bg-[#97d85d] px-4 font-pixel text-[9px] font-bold text-[#1b3700] disabled:opacity-40">ENVOYER</button>
          </form>
          <p className="mt-2 font-jb text-[9px] text-[#8c9380]">Aucun shell n’est lancé : la commande est écrite directement sur stdin de bedrock_server.</p>
        </section>

        <footer className="flex flex-wrap items-center justify-between gap-2 font-jb text-[9px] text-[#777d71]">
          <span>Panel mono-instance · pas de Docker imbriqué · aucune base de données</span>
          <span>{system?.checkedAt ? `Contrôle système ${new Date(system.checkedAt).toLocaleTimeString()}` : 'Contrôle système en attente'}</span>
        </footer>
      </div>
    </main>
  );
}

function CheckRow({ label, ok, detail }: { label: string; ok: boolean | null; detail?: string }) {
  return (
    <div className="mc-inset bg-[#0e0e0e] p-2">
      <div className="flex items-start gap-2">
        <span className={`mt-0.5 ${ok === null ? 'text-[#8c9380]' : ok ? 'text-[#97d85d]' : 'text-[#ff8782]'}`}>{ok === null ? '○' : ok ? '✓' : '!'}</span>
        <span className="text-[#c2c9b5]">{label}</span>
      </div>
      {detail && <p className="ml-5 mt-1 break-words text-[9px] leading-4 text-[#8c9380]">{detail}</p>}
    </div>
  );
}
