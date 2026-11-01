import { AnimatePresence, motion } from 'motion/react';
import {
  AlertTriangle,
  ArrowRight,
  ChevronRight,
  Clock3,
  Copy,
  Database,
  ExternalLink,
  Globe,
  Loader2,
  LockKeyhole,
  Package,
  Play,
  Power,
  RefreshCw,
  Server,
  Users,
  Wifi,
} from 'lucide-react';
import { BedrockMetricsChart } from '../../components/BedrockMetricsChart.tsx';
import { NetherCard } from '../../components/NetherCard.tsx';
import RefineFrame from '../../components/RefineFrame.jsx';
import type { BedrockMetricSample } from '../../utils/metricHistory.ts';
import type {
  DeployConfiguration,
  ManagedWorld,
  PersistentPanelState,
  PlayitSetupSnapshot,
  PortwarpLoginSnapshot,
  ScheduledRestartSnapshot,
  TunnelProvider,
} from '../../types/backend.ts';
import { formatDuration, formatScheduledTime, type PanelTabId, type PublicVersion } from './panelHelpers.ts';
import { LiveUptime, MetricTile, StatusPill, WorldDetail } from './PanelPrimitives.tsx';

export interface OverviewPanelProps {
  reduceMotion: boolean;
  animatePanelEntry: boolean;
  currentServerStatus: string;
  isPipelineBusy: boolean;
  activeConfig: DeployConfiguration | null | undefined;
  activeWorld: ManagedWorld | undefined;
  server: PersistentPanelState['server'] | undefined;
  startDisabled: boolean;
  stopDisabled: boolean;
  busyAction: string | null;
  scheduler: ScheduledRestartSnapshot | undefined;
  providerName: string;
  tunnelProvider: TunnelProvider;
  tunnelStatus: string;
  activeTunnel: { address?: string | null; status: string } | undefined;
  portwarp: PersistentPanelState['portwarp'] | undefined;
  portwarpSetup: PortwarpLoginSnapshot | undefined;
  localtonet: PersistentPanelState['localtonet'] | undefined;
  playit: PersistentPanelState['playit'] | undefined;
  playitSetup: PlayitSetupSnapshot | undefined;
  canOperate: boolean;
  metricHistory: BedrockMetricSample[];
  versionEntry: PublicVersion | undefined;
  onStart: () => void;
  onStop: () => void;
  onSwitchPanel: (tab: PanelTabId) => void;
  onCopy: (value: string, label: string) => void;
  onPlayitSetup: () => void;
  onPortwarpRetry: () => void;
}

export function OverviewPanel({
  reduceMotion,
  animatePanelEntry,
  currentServerStatus,
  isPipelineBusy,
  activeConfig,
  activeWorld,
  server,
  startDisabled,
  stopDisabled,
  busyAction,
  scheduler,
  providerName,
  tunnelProvider,
  tunnelStatus,
  activeTunnel,
  portwarp,
  portwarpSetup,
  localtonet,
  playit,
  playitSetup,
  canOperate,
  metricHistory,
  versionEntry,
  onStart,
  onStop,
  onSwitchPanel,
  onCopy,
  onPlayitSetup,
  onPortwarpRetry,
}: OverviewPanelProps) {
  return (
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
              onClick={onStart}
              disabled={startDisabled}
              whileTap={reduceMotion ? undefined : { scale: 0.97 }}
              className="nether-btn nether-btn--primary"
            >
              {busyAction === 'start' ? <Loader2 className="spin-soft" size={17} /> : <Play size={17} fill="currentColor" />}
              {busyAction === 'start' ? 'Démarrage…' : 'Démarrer Bedrock'}
            </motion.button>
            <motion.button
              type="button"
              onClick={onStop}
              disabled={stopDisabled}
              whileTap={reduceMotion ? undefined : { scale: 0.97 }}
              className="nether-btn nether-btn--danger"
            >
              {busyAction === 'stop' ? <Loader2 className="spin-soft" size={17} /> : <Power size={17} />}
              {busyAction === 'stop' ? 'Arrêt…' : 'Arrêter'}
            </motion.button>
            <motion.button type="button" className="nether-btn nether-btn--quiet" onClick={() => onSwitchPanel('deploy')} whileTap={reduceMotion ? undefined : { scale: 0.97 }}>
              <Package size={16} /> Mettre à jour <ArrowRight size={14} />
            </motion.button>
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
                  onClick={() => onCopy(activeTunnel.address ?? '', 'Adresse')}
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
                        <button type="button" onClick={() => onCopy(portwarpSetup.userCode ?? '', 'Code temporaire')} className="copy-button copy-button--small" aria-label="Copier le code temporaire"><Copy size={14} /></button>
                      </div>
                      <small>Éphémère : affiché dans cette session authentifiée, jamais enregistré dans .env ou l’état du panel.</small>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
              {portwarpSetup?.phase === 'waiting_for_approval' && !portwarpSetup.userCode && !canOperate && (
                <p className="nether-inline-note" role="status">Un compte operator ou supérieur doit consulter le code temporaire et terminer l’autorisation Portwarp.</p>
              )}
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
          {tunnelProvider === 'playit' && playitSetup?.phase === 'claim_pending' && !playitSetup.claimUrl && !canOperate && (
            <p className="nether-inline-note" role="status">Un compte operator ou supérieur doit ouvrir le lien temporaire de rattachement Playit.</p>
          )}
          {tunnelProvider === 'playit' && playitSetup?.phase === 'configured' && !playit?.address && <p className="nether-inline-note">Agent approuvé. Crée un tunnel Bedrock UDP dans ton compte Playit.</p>}
          {tunnelProvider === 'playit' && (playitSetup?.phase === 'waiting_for_secret' || playitSetup?.phase === 'starting') && !playitSetup.claimUrl && <p className="nether-inline-note"><Loader2 size={14} className="spin-soft" /> Préparation du lien de claim…</p>}
          {tunnelProvider === 'playit' && playitSetup?.error && <p role="status" className="inline-error">{playitSetup.error}</p>}
          {tunnelProvider === 'playit' && playit?.error && <p role="status" className="inline-error">{playit.error}</p>}
          {tunnelProvider === 'playit' && (playitSetup?.phase === 'failed' || (playitSetup?.phase === 'waiting_for_secret' && !playitSetup.claimUrl)) && (
            <motion.button type="button" onClick={onPlayitSetup} disabled={!canOperate || busyAction === 'playit'} whileTap={reduceMotion ? undefined : { scale: 0.97 }} className="nether-btn nether-btn--quiet nether-btn--wide">
              {busyAction === 'playit' ? <Loader2 className="spin-soft" size={16} /> : <RefreshCw size={16} />}
              {busyAction === 'playit' ? 'Démarrage…' : 'Réessayer le claim'}
            </motion.button>
          )}

          {tunnelProvider === 'portwarp' && (
            <motion.button
              type="button"
              onClick={onPortwarpRetry}
              disabled={!canOperate || busyAction === 'portwarp'}
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
            <div className="empty-state">
              <Package size={24} />
              <strong>Aucune version déployée</strong>
              <span>Choisis une version Bedrock vérifiée dans le panneau de déploiement.</span>
              <button type="button" className="empty-state__link" onClick={() => onSwitchPanel('deploy')}>
                Configurer le serveur <ChevronRight size={14} />
              </button>
            </div>
          )}
        </NetherCard>
      </section>
    </motion.div>
  );
}
