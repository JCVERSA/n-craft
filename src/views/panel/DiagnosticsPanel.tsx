import { motion } from 'motion/react';
import {
  AlertTriangle,
  Check,
  ExternalLink,
  Layers,
  Loader2,
  LockKeyhole,
  MessageCircle,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import FuseButton from '../../components/FuseButton.jsx';
import { NetherCard } from '../../components/NetherCard.tsx';
import type {
  ChatbotSnapshot,
  PersistentPanelState,
  SystemPreflight,
  TunnelProvider,
} from '../../types/backend.ts';
import { formatBytes, pipelineSteps } from './panelHelpers.ts';
import { CheckRow, PanelHeading, StatusPill } from './PanelPrimitives.tsx';

export interface DiagnosticsPanelProps {
  reduceMotion: boolean;
  animatePanelEntry: boolean;
  canOperate: boolean;
  chatbot: ChatbotSnapshot | undefined;
  chatbotPillStatus: string;
  chatbotPillLabel: string;
  chatbotBusy: boolean;
  chatbotFeedback: string;
  pipeline: PersistentPanelState['pipeline'] | undefined;
  isPipelineBusy: boolean;
  currentStepIndex: number;
  system: SystemPreflight | undefined;
  serverDirectory: string | undefined;
  tunnelProvider: TunnelProvider;
  onChatbotLink: () => void;
  onChatbotCancel: () => void;
  onChatbotUnlink: () => void;
  onChatbotUnlinkUndo: () => void;
}

export function DiagnosticsPanel({
  reduceMotion,
  animatePanelEntry,
  canOperate,
  chatbot,
  chatbotPillStatus,
  chatbotPillLabel,
  chatbotBusy,
  chatbotFeedback,
  pipeline,
  isPipelineBusy,
  currentStepIndex,
  system,
  serverDirectory,
  tunnelProvider,
  onChatbotLink,
  onChatbotCancel,
  onChatbotUnlink,
  onChatbotUnlinkUndo,
}: DiagnosticsPanelProps) {
  return (
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
          eyebrow="DANS LE CHAT MINECRAFT · !AIDE · !JOUEURS · .. <question>"
          description="Mémoire conversationnelle partagée limitée aux 10 derniers échanges. !aide et !joueurs (compteur seul, sans noms ni XUID) sont traitées localement; seuls les messages « .. » sont transmis à l’IA, sans outil ni commande Bedrock."
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
          {chatbot?.userActionPending && !chatbot.deviceCode && !canOperate && (
            <p className="nether-inline-note" role="status">Une autorisation de compte est en attente. Un compte operator ou supérieur est requis pour afficher son code temporaire.</p>
          )}
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
              <button type="button" className="nether-btn nether-btn--primary" onClick={onChatbotLink} disabled={!canOperate || chatbotBusy}>
                {chatbotBusy ? <Loader2 className="spin-soft" size={15} /> : <LockKeyhole size={15} />}
                {chatbot.accountLinked ? 'Réautoriser le compte dédié' : 'Lier un compte dédié'}
              </button>
            )}
            {chatbot?.userActionPending && (
              <button type="button" className="nether-btn nether-btn--quiet" onClick={onChatbotCancel} disabled={!canOperate || chatbotBusy}>
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
                disabled={!canOperate || chatbotBusy}
                onCommit={(reason) => { if (reason === 'fuseEnd') onChatbotUnlink(); }}
                onUndo={onChatbotUnlinkUndo}
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
          description={`Bedrock · ${serverDirectory ?? 'répertoire en attente'}`}
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
  );
}

export default DiagnosticsPanel;
