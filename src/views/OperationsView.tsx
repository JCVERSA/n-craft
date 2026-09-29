import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Activity, AlertTriangle, CheckCircle2, Clock3, Download, HardDrive, Loader2, Plus, RefreshCw,
  RotateCcw, Save, Shield, ShieldCheck, Trash2, UserPlus, Users, Wifi, XCircle,
} from 'lucide-react';
import { NetherCard } from '../components/NetherCard.tsx';
import type {
  AuditEvent, AuthStatus, ManagedPlayer, ManagedWorld, MonitoringSettings, NetworkProbeResult,
  PanelRole, PanelUserSummary, PersistentPanelState, RecoverySettings, RecoverySnapshot,
  SnapshotManagerSnapshot, SystemPreflight,
} from '../types/backend.ts';
import type { MonitoringSnapshot } from '../monitoring.ts';

interface OperationsViewProps {
  role: PanelRole | null;
  authStatus: AuthStatus | null;
  worlds: ManagedWorld[];
  state: PersistentPanelState | null;
  system: SystemPreflight | null;
  snapshots: SnapshotManagerSnapshot | null;
  recovery: RecoverySnapshot | null;
  monitoring: MonitoringSnapshot | null;
  refreshStatus: () => Promise<void>;
  onNotify: (tone: 'success' | 'warning' | 'error' | 'info', title: string, description: string) => void;
}

class OperationRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(url, { ...options, headers, credentials: 'same-origin', cache: 'no-store' });
  const payload = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw new OperationRequestError(payload.error || `Erreur HTTP ${response.status}.`, response.status);
  return payload;
}

function humanBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} Go`;
  return `${(value / 1024 ** 2).toFixed(0)} Mio`;
}

function humanDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
}

const EMPTY_RECOVERY: RecoverySettings = {
  restartAfterCrash: true,
  startAfterPanelRestart: false,
  maxAttempts: 5,
  delaySeconds: 10,
};
const EMPTY_MONITORING: MonitoringSettings = {
  lowDiskBytes: 512 * 1024 ** 2,
  highCpuPercent: 90,
  highMemoryBytes: 6 * 1024 ** 3,
};

export function OperationsView({
  role, authStatus, worlds, state, system, snapshots, recovery, monitoring, refreshStatus, onNotify,
}: OperationsViewProps) {
  const canAdmin = role === 'owner' || role === 'admin';
  const canOperate = role !== null && role !== 'viewer';
  const isOwner = role === 'owner';
  const [players, setPlayers] = useState<ManagedPlayer[]>([]);
  const [adminXuids, setAdminXuids] = useState<string[]>([]);
  const [adminDraft, setAdminDraft] = useState('');
  const [users, setUsers] = useState<PanelUserSummary[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [selectedWorldId, setSelectedWorldId] = useState('');
  const [recoveryDraft, setRecoveryDraft] = useState<RecoverySettings>(EMPTY_RECOVERY);
  const [monitoringDraft, setMonitoringDraft] = useState<MonitoringSettings>(EMPTY_MONITORING);
  const [intervalHours, setIntervalHours] = useState(24);
  const [retention, setRetention] = useState(3);
  const [storageLimitGb, setStorageLimitGb] = useState(10);
  const [snapshotsEnabled, setSnapshotsEnabled] = useState(false);
  const [usernameDraft, setUsernameDraft] = useState('');
  const [passwordDraft, setPasswordDraft] = useState('');
  const [newRole, setNewRole] = useState<Exclude<PanelRole, 'owner'>>('viewer');
  const [localProbe, setLocalProbe] = useState<NetworkProbeResult | null>(null);
  const [tunnelProbe, setTunnelProbe] = useState<NetworkProbeResult | null>(null);
  const [probeBusy, setProbeBusy] = useState<'local' | 'tunnel' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const readyWorlds = useMemo(() => worlds.filter((world) => world.status === 'ready'), [worlds]);
  const selectedWorld = worlds.find((world) => world.id === selectedWorldId) ?? readyWorlds[0];
  const worldSnapshots = snapshots?.snapshots.filter((snapshot) => snapshot.worldId === selectedWorld?.id) ?? [];
  const currentServer = state?.server;
  const serverStopped = Boolean(currentServer && (currentServer.status === 'stopped'
    || (currentServer.status === 'failed' && currentServer.pid === null)));
  const pipelineBusy = state?.pipeline.status === 'running';

  useEffect(() => {
    if (!selectedWorldId || !worlds.some((world) => world.id === selectedWorldId)) {
      setSelectedWorldId(readyWorlds[0]?.id ?? worlds[0]?.id ?? '');
    }
  }, [readyWorlds, selectedWorldId, worlds]);

  useEffect(() => {
    if (recovery) setRecoveryDraft({ ...recovery.settings });
  }, [recovery?.settings.restartAfterCrash, recovery?.settings.startAfterPanelRestart, recovery?.settings.maxAttempts, recovery?.settings.delaySeconds]);
  useEffect(() => {
    if (monitoring) setMonitoringDraft({ ...monitoring.settings });
  }, [monitoring?.settings.lowDiskBytes, monitoring?.settings.highCpuPercent, monitoring?.settings.highMemoryBytes]);
  useEffect(() => {
    if (!snapshots) return;
    setSnapshotsEnabled(snapshots.settings.enabled);
    setIntervalHours(snapshots.settings.intervalHours);
    setRetention(snapshots.settings.retentionPerWorld);
    setStorageLimitGb(Number((snapshots.settings.maxStorageBytes / 1024 ** 3).toFixed(2)));
  }, [snapshots?.settings.enabled, snapshots?.settings.intervalHours, snapshots?.settings.retentionPerWorld, snapshots?.settings.maxStorageBytes]);
  useEffect(() => {
    const current = state?.activeConfig?.adminXuids ?? [];
    setAdminXuids([...current]);
    setAdminDraft(current.join('\n'));
  }, [state?.activeConfig?.version, state?.activeConfig?.levelName, state?.activeConfig?.adminXuids]);

  const refreshRoster = useCallback(async () => {
    const result = await request<{ players: ManagedPlayer[]; admins: string[] }>('/api/server/players');
    setPlayers(result.players);
    setAdminXuids(result.admins);
    setAdminDraft(result.admins.join('\n'));
  }, []);
  const refreshAudit = useCallback(async () => {
    const result = await request<{ events: AuditEvent[] }>('/api/server/audit?limit=80');
    setAuditEvents(result.events);
  }, []);
  const refreshUsers = useCallback(async () => {
    const result = await request<{ users: PanelUserSummary[] }>('/api/auth/users');
    setUsers(result.users);
  }, []);

  useEffect(() => {
    let alive = true;
    void Promise.allSettled([refreshRoster(), canAdmin ? refreshAudit() : Promise.resolve(), isOwner ? refreshUsers() : Promise.resolve()])
      .then((results) => {
        if (!alive) return;
        const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failure) onNotify('warning', 'Certaines données restent indisponibles', (failure.reason as Error)?.message || 'Réessaie dans un instant.');
      });
    return () => { alive = false; };
  }, [canAdmin, isOwner, onNotify, refreshAudit, refreshRoster, refreshUsers]);

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    try { await action(); }
    catch (error) { onNotify('error', 'Opération impossible', (error as Error).message || 'Réessaie dans un instant.'); }
    finally { setBusy(null); }
  };

  const runProbe = async (source: 'local' | 'tunnel') => {
    setProbeBusy(source);
    try {
      const result = await request<NetworkProbeResult>(`/api/server/network-check?source=${source}`);
      if (source === 'local') setLocalProbe(result);
      else setTunnelProbe(result);
    } catch (error) {
      onNotify('error', 'Test UDP impossible', (error as Error).message || 'Réessaie.');
    } finally { setProbeBusy(null); }
  };

  const saveAdmins = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = adminDraft.split(/[\n,;]/).map((value) => value.trim()).filter(Boolean);
    await run('admins', async () => {
      const result = await request<{ admins: string[] }>('/api/server/access/admins', {
        method: 'PUT', body: JSON.stringify({ adminXuids: values }),
      });
      setAdminXuids(result.admins);
      await refreshStatus();
      onNotify('success', 'Administrateurs Bedrock enregistrés', 'permissions.json sera pris en compte au prochain démarrage du serveur.');
      await refreshAudit().catch(() => undefined);
    });
  };

  const createSnapshot = async () => {
    if (!selectedWorld) return;
    await run('snapshot-create', async () => {
      const result = await request<{ snapshot: { sizeBytes: number } }>(`/api/server/worlds/${encodeURIComponent(selectedWorld.id)}/snapshots`, {
        method: 'POST', body: '{}',
      });
      onNotify('success', 'Snapshot créé', `${selectedWorld.name} · ${humanBytes(result.snapshot.sizeBytes)}.`);
      await refreshStatus();
      if (canAdmin) await refreshAudit().catch(() => undefined);
    });
  };

  const restoreSnapshot = async (id: string) => {
    const snapshot = worldSnapshots.find((candidate) => candidate.id === id);
    if (!snapshot || !selectedWorld) return;
    const confirmed = window.confirm(`Restaurer le snapshot du ${humanDate(snapshot.createdAt)} pour « ${selectedWorld.name} » ? Une sauvegarde préalable du dossier courant sera créée avant le remplacement.`);
    if (!confirmed) return;
    await run(`restore-${id}`, async () => {
      const result = await request<{ beforeRestore: { id: string } | null }>(`/api/server/snapshots/${encodeURIComponent(id)}/restore`, {
        method: 'POST', body: '{}',
      });
      onNotify('success', 'Monde restauré', result.beforeRestore
        ? `La sauvegarde préalable ${result.beforeRestore.id.slice(0, 8)} est conservée dans la liste des snapshots.`
        : 'Le dossier monde était absent; les données du snapshot ont été installées dans un nouveau dossier.');
      await refreshStatus();
      await refreshAudit().catch(() => undefined);
    });
  };

  const deleteSnapshot = async (id: string) => {
    if (!window.confirm('Supprimer définitivement cette archive snapshot ? Cette action ne supprime pas le monde courant.')) return;
    await run(`delete-${id}`, async () => {
      await request(`/api/server/snapshots/${encodeURIComponent(id)}`, { method: 'DELETE', body: '{}' });
      onNotify('success', 'Snapshot supprimé', 'Le dossier du monde courant n’a pas été modifié.');
      await refreshStatus();
      await refreshAudit().catch(() => undefined);
    });
  };

  const saveSnapshotSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await run('snapshot-settings', async () => {
      await request('/api/server/snapshots/settings', {
        method: 'PUT',
        body: JSON.stringify({
          enabled: snapshotsEnabled,
          intervalHours: Number(intervalHours),
          retentionPerWorld: Number(retention),
          maxStorageBytes: Math.round(Number(storageLimitGb) * 1024 ** 3),
        }),
      });
      onNotify('success', 'Planification des snapshots enregistrée', snapshotsEnabled ? `Un snapshot sera tenté toutes les ${intervalHours} h.` : 'Les snapshots automatiques sont désactivés.');
      await refreshStatus();
      await refreshAudit().catch(() => undefined);
    });
  };

  const saveRecoverySettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await run('recovery-settings', async () => {
      await request('/api/server/recovery/settings', { method: 'PUT', body: JSON.stringify(recoveryDraft) });
      onNotify('success', 'Reprise automatique configurée', 'La temporisation exponentielle et la limite de tentatives protègent contre les boucles de crash.');
      await refreshStatus();
      await refreshAudit().catch(() => undefined);
    });
  };

  const saveMonitoringSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await run('monitoring-settings', async () => {
      await request('/api/server/monitoring/settings', { method: 'PUT', body: JSON.stringify(monitoringDraft) });
      onNotify('success', 'Seuils d’alerte enregistrés', 'Les alertes sont visibles dans ce panneau de supervision.');
      await refreshStatus();
      await refreshAudit().catch(() => undefined);
    });
  };

  const createPanelUser = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await run('user-create', async () => {
      await request('/api/auth/users', {
        method: 'POST', body: JSON.stringify({ username: usernameDraft, password: passwordDraft, role: newRole }),
      });
      setUsernameDraft('');
      setPasswordDraft('');
      await refreshUsers();
      await refreshAudit();
      onNotify('success', 'Compte panneau créé', 'Le mot de passe est conservé uniquement sous forme de hash salé.');
    });
  };

  const changePanelUserRole = async (user: PanelUserSummary, nextRole: Exclude<PanelRole, 'owner'>) => {
    await run(`role-${user.id}`, async () => {
      await request(`/api/auth/users/${encodeURIComponent(user.id)}`, { method: 'PATCH', body: JSON.stringify({ role: nextRole }) });
      await refreshUsers();
      await refreshAudit();
      onNotify('success', 'Rôle mis à jour', `${user.username} · ${nextRole}.`);
    });
  };

  const deletePanelUser = async (user: PanelUserSummary) => {
    if (!window.confirm(`Supprimer le compte « ${user.username} » et révoquer ses sessions ?`)) return;
    await run(`user-${user.id}`, async () => {
      await request(`/api/auth/users/${encodeURIComponent(user.id)}`, { method: 'DELETE', body: '{}' });
      await refreshUsers();
      await refreshAudit();
      onNotify('success', 'Compte supprimé', `Les sessions de ${user.username} ont été révoquées.`);
    });
  };

  const refreshAll = () => run('refresh', async () => {
    await Promise.all([refreshStatus(), refreshRoster(), canAdmin ? refreshAudit() : Promise.resolve(), isOwner ? refreshUsers() : Promise.resolve()]);
  });

  return (
    <div className="ncraft-tab-panel__content operations-view">
      <header className="ncraft-tab-heading ncraft-tab-heading--diagnostics">
        <div className="ncraft-tab-heading__copy">
          <p className="nether-eyebrow">SUPERVISION · ACCÈS · SAUVEGARDES</p>
          <h1>Opérations du serveur</h1>
          <p>Snapshots Bedrock, disponibilité UDP, reprise après crash, roster et accès au panneau — protégés par les rôles de session.</p>
        </div>
        <span className="ncraft-tab-heading__ornament" aria-hidden="true"><span /><span /><span /></span>
      </header>

      <div className="operations-grid">
        <NetherCard title="Snapshots des mondes" eyebrow="SAUVEGARDE ET RESTAURATION" icon={HardDrive} accent="moss" className="operations-card operations-card--wide" action={<span className="world-manager-count">{snapshots?.snapshots.length ?? 0} archive{snapshots?.snapshots.length === 1 ? '' : 's'}</span>}>
          <div className="operations-note">
            <ShieldCheck size={16} />
            <span>En ligne : Nebula envoie <code>save hold</code>, répète <code>save query</code> et tente toujours <code>save resume</code>. Les snapshots sont des archives .mcworld restaurables.</span>
          </div>
          {snapshots?.diskWarning && <div className="nether-callout nether-callout--warning"><AlertTriangle size={17} /><span>Espace disque ou plafond de snapshots presque atteint. Vérifie le stockage avant de lancer une sauvegarde.</span></div>}
          {snapshots?.settings.lastError && <div role="status" className="operations-error">Dernier snapshot automatique : {snapshots.settings.lastError}</div>}
          <div className="operations-storage-row">
            <span>Stockage snapshots <strong>{humanBytes(snapshots?.storageUsedBytes)}</strong> / {humanBytes(snapshots?.settings.maxStorageBytes)}</span>
            <span>Espace libre <strong>{humanBytes(snapshots?.diskFreeBytes)}</strong></span>
          </div>
          {readyWorlds.length > 0 ? (
            <div className="operations-world-picker">
              <label className="nether-field" htmlFor="snapshot-world-select">
                <span>Monde à sauvegarder ou restaurer</span>
                <select id="snapshot-world-select" className="nether-input" value={selectedWorld?.id ?? ''} onChange={(event) => setSelectedWorldId(event.target.value)}>
                  {readyWorlds.map((world) => <option key={world.id} value={world.id}>{world.name} · BDS {world.version}</option>)}
                </select>
              </label>
              <button type="button" className="nether-btn nether-btn--primary" disabled={!canOperate || busy !== null || !selectedWorld} onClick={() => void createSnapshot()}>
                {busy === 'snapshot-create' ? <Loader2 className="spin-soft" size={16} /> : <Save size={16} />} Créer un snapshot
              </button>
            </div>
          ) : <div className="empty-state"><HardDrive size={23} /><strong>Aucun monde prêt</strong><span>Déploie ou importe un monde avant de créer des snapshots.</span></div>}
          {selectedWorld && worldSnapshots.length > 0 ? (
            <div className="operations-snapshot-list" aria-label={`Snapshots de ${selectedWorld.name}`}>
              {worldSnapshots.map((snapshot) => (
                <article className="operations-snapshot-row" key={snapshot.id}>
                  <div className="operations-snapshot-row__copy">
                    <strong>{humanDate(snapshot.createdAt)}</strong>
                    <span>{snapshot.reason === 'scheduled' ? 'Automatique' : snapshot.reason === 'before-restore' ? 'Avant restauration' : snapshot.reason === 'before-deploy' ? 'Avant déploiement' : 'Manuel'} · {humanBytes(snapshot.sizeBytes)}</span>
                    <small>ID {snapshot.id.slice(0, 8)}</small>
                  </div>
                  <div className="operations-inline-actions">
                    <a className="nether-btn nether-btn--quiet nether-btn--tiny" href={`/api/server/snapshots/${encodeURIComponent(snapshot.id)}/download`} aria-label={`Télécharger snapshot du ${humanDate(snapshot.createdAt)}`}><Download size={15} /> Télécharger</a>
                    <button type="button" className="nether-btn nether-btn--quiet nether-btn--tiny" disabled={!canAdmin || !serverStopped || pipelineBusy || busy !== null} onClick={() => void restoreSnapshot(snapshot.id)} title={!serverStopped ? 'Arrête Bedrock avant de restaurer' : 'La sauvegarde actuelle sera créée avant restauration'}><RotateCcw size={15} /> Restaurer</button>
                    <button type="button" className="nether-btn nether-btn--danger nether-btn--tiny" disabled={!canAdmin || busy !== null} onClick={() => void deleteSnapshot(snapshot.id)} aria-label={`Supprimer snapshot ${snapshot.id.slice(0, 8)}`}><Trash2 size={15} /></button>
                  </div>
                </article>
              ))}
            </div>
          ) : selectedWorld ? <p className="operations-muted">Aucun snapshot enregistré pour ce monde.</p> : null}
          {canAdmin && (
            <form className="operations-settings-form" onSubmit={(event) => void saveSnapshotSettings(event)}>
              <h3>Planification et rétention</h3>
              <label className="operations-check"><input type="checkbox" checked={snapshotsEnabled} onChange={(event) => setSnapshotsEnabled(event.target.checked)} />Snapshots automatiques activés</label>
              <div className="operations-form-grid">
                <label className="nether-field"><span>Intervalle (heures)</span><input className="nether-input" type="number" min={1} max={168} value={intervalHours} onChange={(event) => setIntervalHours(Number(event.target.value))} /></label>
                <label className="nether-field"><span>Rétention par monde</span><input className="nether-input" type="number" min={1} max={20} value={retention} onChange={(event) => setRetention(Number(event.target.value))} /></label>
                <label className="nether-field"><span>Plafond stockage (Go)</span><input className="nether-input" type="number" min={0.5} max={1024} step={0.5} value={storageLimitGb} onChange={(event) => setStorageLimitGb(Number(event.target.value))} /></label>
              </div>
              <p className="operations-muted">Prochain snapshot : {humanDate(snapshots?.settings.nextRunAt)} · dernier : {humanDate(snapshots?.settings.lastRunAt)}. Désactivé par défaut pour éviter un gel non prévu de Bedrock.</p>
              <button className="nether-btn nether-btn--quiet" type="submit" disabled={busy !== null}><Save size={15} /> Enregistrer la planification</button>
            </form>
          )}
          {!canOperate && <p className="operations-muted">Le rôle operator ou supérieur est requis pour créer un snapshot ; un admin est requis pour restaurer, supprimer et planifier.</p>}
          {canOperate && !canAdmin && <p className="operations-muted">Operator peut créer et télécharger des snapshots. Admin est requis pour restaurer, supprimer et modifier la planification.</p>}
        </NetherCard>

        <NetherCard title="Joignabilité UDP / Bedrock" eyebrow="PING RAKNET" icon={Wifi} accent="portal">
          <p className="operations-muted">Mesure une réponse RakNet Bedrock (pas un ping ICMP ni une simple ouverture TCP).</p>
          <div className="operations-probe-grid">
            <div className="operations-probe-card">
              <div><strong>Loopback local</strong><span>127.0.0.1:19132 · depuis le conteneur</span></div>
              <button className="nether-btn nether-btn--quiet nether-btn--tiny" type="button" onClick={() => void runProbe('local')} disabled={probeBusy !== null}>{probeBusy === 'local' ? <Loader2 className="spin-soft" size={15} /> : <Wifi size={15} />} Tester</button>
              {localProbe && <ProbeSummary result={localProbe} />}
            </div>
            <div className="operations-probe-card">
              <div><strong>Adresse publique du tunnel</strong><span>Probe sortante depuis le conteneur; le NAT loopback peut fausser le résultat.</span></div>
              <button className="nether-btn nether-btn--quiet nether-btn--tiny" type="button" onClick={() => void runProbe('tunnel')} disabled={probeBusy !== null}>{probeBusy === 'tunnel' ? <Loader2 className="spin-soft" size={15} /> : <Wifi size={15} />} Tester</button>
              {tunnelProbe && <ProbeSummary result={tunnelProbe} />}
            </div>
          </div>
          <p className="operations-warning-copy"><AlertTriangle size={15} />Ce panneau ne peut pas confirmer une connexion indépendante depuis Internet. Pour une vérification externe réelle, teste l’adresse depuis un autre réseau ou un client Bedrock.</p>
        </NetherCard>

        <NetherCard title="Reprise automatique" eyebrow="RÉSILIENCE BEDROCK" icon={RotateCcw} accent="magma">
          <div className="operations-status-row"><span>État : <strong>{recovery?.phase ?? '—'}</strong></span><span>Tentatives : <strong>{recovery?.attempts ?? 0}/{recovery?.settings.maxAttempts ?? 5}</strong></span></div>
          <p className="operations-muted">Prochaine tentative : {humanDate(recovery?.nextAttemptAt)} · {recovery?.lastError ?? 'aucune erreur récente'}</p>
          {recovery?.startupPending && <p className="nether-callout nether-callout--warning"><Clock3 size={15} />Démarrage après redémarrage du panneau en attente.</p>}
          {canAdmin ? (
            <form className="operations-settings-form" onSubmit={(event) => void saveRecoverySettings(event)}>
              <label className="operations-check"><input type="checkbox" checked={recoveryDraft.restartAfterCrash} onChange={(event) => setRecoveryDraft((current) => ({ ...current, restartAfterCrash: event.target.checked }))} />Redémarrer après un crash inattendu</label>
              <label className="operations-check"><input type="checkbox" checked={recoveryDraft.startAfterPanelRestart} onChange={(event) => setRecoveryDraft((current) => ({ ...current, startAfterPanelRestart: event.target.checked }))} />Redémarrer si le panneau / conteneur redémarre</label>
              <div className="operations-form-grid">
                <label className="nether-field"><span>Nombre maximal d’essais</span><input className="nether-input" type="number" min={1} max={10} value={recoveryDraft.maxAttempts} onChange={(event) => setRecoveryDraft((current) => ({ ...current, maxAttempts: Number(event.target.value) }))} /></label>
                <label className="nether-field"><span>Délai initial (secondes)</span><input className="nether-input" type="number" min={1} max={3600} value={recoveryDraft.delaySeconds} onChange={(event) => setRecoveryDraft((current) => ({ ...current, delaySeconds: Number(event.target.value) }))} /></label>
              </div>
              <p className="operations-muted">Le délai double à chaque essai (plafond 5 minutes). Le compteur revient à zéro après 10 minutes stables.</p>
              <button type="submit" className="nether-btn nether-btn--quiet" disabled={busy !== null}><Save size={15} /> Enregistrer la reprise</button>
            </form>
          ) : <p className="operations-muted">Seul un admin peut modifier la politique de reprise.</p>}
        </NetherCard>

        <NetherCard title="Métriques et alertes" eyebrow="SEUILS CONFIGURABLES" icon={Activity} accent="soul">
          {monitoring?.alerts.length ? (
            <div className="operations-alert-list" aria-live="polite">
              {monitoring.alerts.map((alert) => <div key={alert.id} className={`operations-alert operations-alert--${alert.severity}`}><AlertTriangle size={16} /><div><strong>{alert.title}</strong><span>{alert.detail}</span><small>Depuis {humanDate(alert.since)}</small></div></div>)}
            </div>
          ) : <div className="operations-clear-state"><CheckCircle2 size={16} />Aucune alerte active.</div>}
          <p className="operations-muted">Dernier échantillon {humanDate(monitoring?.samples.at(-1)?.timestamp)} · CPU BDS {monitoring?.samples.at(-1)?.cpuPercent === null || monitoring?.samples.at(-1)?.cpuPercent === undefined ? '—' : `${monitoring.samples.at(-1)?.cpuPercent?.toFixed(0)} %`} · mémoire {humanBytes(monitoring?.samples.at(-1)?.memoryBytes)} · disque DATA {humanBytes(system?.dataDiskFreeBytes)} / serveur {humanBytes(system?.serverDiskFreeBytes)}.</p>
          {canAdmin ? (
            <form className="operations-settings-form" onSubmit={(event) => void saveMonitoringSettings(event)}>
              <div className="operations-form-grid">
                <label className="nether-field"><span>Alerter sous (Go libres)</span><input className="nether-input" type="number" min={0.0625} max={1024} step={0.0625} value={Number((monitoringDraft.lowDiskBytes / 1024 ** 3).toFixed(4))} onChange={(event) => setMonitoringDraft((current) => ({ ...current, lowDiskBytes: Math.round(Number(event.target.value) * 1024 ** 3) }))} /></label>
                <label className="nether-field"><span>Alerter au-dessus (% CPU)</span><input className="nether-input" type="number" min={25} max={100} value={monitoringDraft.highCpuPercent} onChange={(event) => setMonitoringDraft((current) => ({ ...current, highCpuPercent: Number(event.target.value) }))} /></label>
                <label className="nether-field"><span>Alerter au-dessus (Go RAM)</span><input className="nether-input" type="number" min={0.25} max={1024} step={0.25} value={Number((monitoringDraft.highMemoryBytes / 1024 ** 3).toFixed(2))} onChange={(event) => setMonitoringDraft((current) => ({ ...current, highMemoryBytes: Math.round(Number(event.target.value) * 1024 ** 3) }))} /></label>
              </div>
              <button type="submit" className="nether-btn nether-btn--quiet" disabled={busy !== null}><Save size={15} /> Enregistrer les seuils</button>
            </form>
          ) : <p className="operations-muted">Seul un admin peut modifier les seuils d’alerte.</p>}
        </NetherCard>

        <NetherCard title="Joueurs et administrateurs Bedrock" eyebrow="ROSTER OBSERVÉ · permissions.json" icon={Users} accent="portal">
          <p className="operations-muted">Le roster est reconstruit à partir des connexions vues dans la console. Les administrateurs sont enregistrés par XUID; un changement nécessite un redémarrage Bedrock.</p>
          <div className="operations-player-list">
            {players.length === 0 ? <div className="operations-clear-state"><Users size={16} />Aucun joueur observé pour l’instant.</div> : players.slice(0, 30).map((player) => (
              <div className="operations-player-row" key={player.id}>
                <span className={`operations-player-dot ${player.online ? 'is-online' : ''}`} aria-hidden="true" />
                <div><strong>{player.name}</strong><span>{player.xuid ? `XUID ${player.xuid}` : 'XUID non fourni par le journal'}</span></div>
                <small>{player.online ? 'En ligne' : `Vu ${humanDate(player.lastSeenAt)}`}</small>
                {player.xuid && adminXuids.includes(player.xuid) && <span className="operations-role-badge">ADMIN BDS</span>}
              </div>
            ))}
          </div>
          {canAdmin && (
            <form className="operations-settings-form" onSubmit={(event) => void saveAdmins(event)}>
              <label className="nether-field" htmlFor="bedrock-admin-xuids"><span>XUID administrateur (1 à 3 valeurs, une par ligne)</span><textarea id="bedrock-admin-xuids" className="nether-input operations-textarea" rows={3} maxLength={70} value={adminDraft} onChange={(event) => setAdminDraft(event.target.value)} aria-describedby="bedrock-admin-help" /></label>
              <small id="bedrock-admin-help" className="operations-muted">Les gamertags ne sont pas convertis ou recherchés. Le convertisseur XUID local est dans Déploiement.</small>
              <button type="submit" className="nether-btn nether-btn--quiet" disabled={busy !== null || serverStopped === false}><Save size={15} /> Enregistrer permissions.json</button>
              {!serverStopped && <small className="operations-muted">Arrête Bedrock avant de modifier les permissions.</small>}
            </form>
          )}
        </NetherCard>

        <NetherCard title="Comptes du panneau" eyebrow="RBAC · MOTS DE PASSE HASHÉS" icon={Shield} accent="magma">
          <div className="operations-role-legend"><span><b>owner</b> Jeton PANEL_TOKEN</span><span><b>admin</b> opérations et réglages</span><span><b>operator</b> commandes courantes</span><span><b>viewer</b> lecture seule</span></div>
          {isOwner ? (
            <>
              <form className="operations-user-form" onSubmit={(event) => void createPanelUser(event)}>
                <label className="nether-field"><span>Nom de compte</span><input className="nether-input" autoComplete="off" minLength={3} maxLength={32} pattern="[A-Za-z0-9_.-]{3,32}" required value={usernameDraft} onChange={(event) => setUsernameDraft(event.target.value)} /></label>
                <label className="nether-field"><span>Mot de passe (12 caractères min.)</span><input className="nether-input" type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={passwordDraft} onChange={(event) => setPasswordDraft(event.target.value)} /></label>
                <label className="nether-field"><span>Rôle</span><select className="nether-input" value={newRole} onChange={(event) => setNewRole(event.target.value as Exclude<PanelRole, 'owner'>)}><option value="viewer">viewer · lecture seule</option><option value="operator">operator · commandes</option><option value="admin">admin · réglages</option></select></label>
                <button className="nether-btn nether-btn--primary" type="submit" disabled={busy !== null}><UserPlus size={15} /> Créer le compte</button>
              </form>
              <div className="operations-user-list">
                {users.length === 0 ? <p className="operations-muted">Aucun compte secondaire. Le jeton propriétaire reste actif.</p> : users.map((user) => (
                  <div className="operations-user-row" key={user.id}>
                    <div><strong>{user.username}</strong><small>{user.role} · créé {humanDate(user.createdAt)}</small></div>
                    <select aria-label={`Rôle de ${user.username}`} className="nether-input operations-role-select" value={user.role} disabled={busy !== null} onChange={(event) => void changePanelUserRole(user, event.target.value as Exclude<PanelRole, 'owner'>)}><option value="viewer">viewer</option><option value="operator">operator</option><option value="admin">admin</option></select>
                    <button type="button" className="nether-btn nether-btn--danger nether-btn--tiny" disabled={busy !== null} onClick={() => void deletePanelUser(user)} aria-label={`Supprimer ${user.username}`}><Trash2 size={15} /></button>
                  </div>
                ))}
              </div>
            </>
          ) : <p className="operations-muted">Connecté en tant que <strong>{authStatus?.username ?? '—'}</strong> · rôle <strong>{role ?? '—'}</strong>. Seul le propriétaire utilisant PANEL_TOKEN peut créer, modifier ou révoquer les comptes du panneau.</p>}
        </NetherCard>

        <NetherCard title="Diagnostic et journal d’activité" eyebrow="EXPORT PARTAGEABLE · REDACTÉ" icon={ShieldCheck} accent="soul" className="operations-card operations-card--wide">
          <div className="operations-diagnostic-actions">
            <div><strong>Exporter le diagnostic</strong><span>JSON expurgé : aucun .env, mot de passe, token, XUID, seed, adresse de tunnel, commande console ou contenu de monde.</span></div>
            <a className="nether-btn nether-btn--primary" href="/api/server/diagnostics/export"><Download size={16} /> Télécharger le diagnostic</a>
          </div>
          {canAdmin && <div className="operations-audit-list" aria-label="Journal des activités">
            <h3>Activité récente <button type="button" className="nether-btn nether-btn--quiet nether-btn--tiny" disabled={busy !== null} onClick={() => void run('audit-refresh', refreshAudit)}><RefreshCw size={14} /> Actualiser</button></h3>
            {auditEvents.length === 0 ? <p className="operations-muted">Aucune activité enregistrée.</p> : auditEvents.slice(0, 30).map((event) => (
              <div className="operations-audit-row" key={event.id}><time dateTime={event.timestamp}>{humanDate(event.timestamp)}</time><strong>{event.actor} <small>{event.role}</small></strong><span>{event.action}</span><p>{event.detail}</p></div>
            ))}
          </div>}
          <p className="operations-muted">Le journal local est limité aux 1 000 événements les plus récents. Les mots de passe et secrets ne sont jamais consignés.</p>
        </NetherCard>
      </div>
    </div>
  );
}

function ProbeSummary({ result }: { result: NetworkProbeResult }) {
  const positive = result.status === 'reachable';
  const negative = result.status === 'unreachable' || result.status === 'server-stopped';
  return (
    <div className={`operations-probe-result ${positive ? 'is-good' : negative ? 'is-bad' : ''}`} role="status" aria-live="polite">
      {positive ? <CheckCircle2 size={16} /> : negative ? <XCircle size={16} /> : <AlertTriangle size={16} />}
      <div><strong>{positive ? `Joignable · ${result.latencyMs} ms` : result.status === 'unconfigured' ? 'Adresse indisponible' : result.status === 'server-stopped' ? 'Serveur arrêté' : 'Aucune réponse'}</strong><span>{result.target ?? '—'} · {result.message}</span>{result.serverName && <small>{result.serverName}</small>}</div>
    </div>
  );
}
