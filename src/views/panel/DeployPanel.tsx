import type { FormEvent } from 'react';
import { motion } from 'motion/react';
import {
  ArrowRight,
  Database,
  Globe,
  Loader2,
  LockKeyhole,
  Package,
  Save,
  ShieldCheck,
  Users,
  Wifi,
  X,
} from 'lucide-react';
import { GlideSelect, type GlideSelectOption } from '../../components/GlideSelect.tsx';
import JellyRadio from '../../components/JellyRadio.jsx';
import { NetherCard } from '../../components/NetherCard.tsx';
import { RubberSegment } from '../../components/RubberSegment.tsx';
import { SeedTools } from '../../components/SeedTools.tsx';
import { SpringCheck } from '../../components/SpringCheck.tsx';
import { XuidConverter } from '../../components/XuidConverter.tsx';
import type { DeployConfiguration, ManagedWorld } from '../../types/backend.ts';
import { difficultyOptions, gameModeOptions, type PublicVersion } from './panelHelpers.ts';
import { PanelHeading } from './PanelPrimitives.tsx';

export interface DeployPanelProps {
  reduceMotion: boolean;
  animatePanelEntry: boolean;
  canAdmin: boolean;
  isExistingDeployment: boolean;
  bedrockMayBeRunning: boolean;
  configurationLocked: boolean;
  deploymentVersionOptions: GlideSelectOption[];
  configuration: DeployConfiguration;
  selectedVersion: PublicVersion | undefined;
  versionsCount: number;
  selectedWorldId: string | null;
  selectedWorld: ManagedWorld | undefined;
  worldsForSelectedVersion: ManagedWorld[];
  newWorldName: string;
  isPipelineBusy: boolean;
  isEditingWorldSettings: boolean;
  editingWorld: ManagedWorld | undefined;
  worldBusyId: string | null;
  operationNeedsDeploy: boolean;
  configurationActionDisabled: boolean;
  configurationActionLabel: string;
  onDeploySubmit: (event: FormEvent<HTMLFormElement>) => void;
  onSaveWorldSettings: () => void;
  onSaveConfiguration: () => void;
  onChangeField: <K extends keyof DeployConfiguration>(key: K, value: DeployConfiguration[K]) => void;
  onChooseNewWorld: () => void;
  onChooseWorld: (world: ManagedWorld, editSettings: boolean) => void;
  onNewWorldNameChange: (value: string) => void;
  onAddAdminField: () => void;
  onSetAdminXuid: (index: number, value: string) => void;
  onRemoveAdminField: (index: number) => void;
  onCopy: (value: string, label: string) => Promise<void> | void;
}

export function DeployPanel({
  reduceMotion,
  animatePanelEntry,
  canAdmin,
  isExistingDeployment,
  bedrockMayBeRunning,
  configurationLocked,
  deploymentVersionOptions,
  configuration,
  selectedVersion,
  versionsCount,
  selectedWorldId,
  selectedWorld,
  worldsForSelectedVersion,
  newWorldName,
  isPipelineBusy,
  isEditingWorldSettings,
  editingWorld,
  worldBusyId,
  operationNeedsDeploy,
  configurationActionDisabled,
  configurationActionLabel,
  onDeploySubmit,
  onSaveWorldSettings,
  onSaveConfiguration,
  onChangeField,
  onChooseNewWorld,
  onChooseWorld,
  onNewWorldNameChange,
  onAddAdminField,
  onSetAdminXuid,
  onRemoveAdminField,
  onCopy,
}: DeployPanelProps) {
  const adminXuidsLocked = configurationLocked || !canAdmin;

  return (
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
          <form onSubmit={onDeploySubmit} className="deploy-form">
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
                  options={deploymentVersionOptions}
                  value={configuration.version}
                  onChange={(value) => onChangeField('version', value)}
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
                <small className={!selectedVersion && versionsCount > 0 ? 'cartridge-slot__version-error' : undefined}>
                  {selectedVersion
                    ? `${selectedVersion.channel === 'preview' ? 'Preview' : 'Version stable'} · client ${selectedVersion.clientVersion}${selectedVersion.releaseDate ? ` · sortie ${selectedVersion.releaseDate}` : ''}`
                    : versionsCount > 0 ? 'Version indisponible · choisis une version du catalogue' : 'Catalogue historique du panneau'}
                </small>
              </div>
            </div>
            {versionsCount === 0 && <p className="inline-error">Aucune archive BDS configurée dans le catalogue local.</p>}

            <fieldset className="world-choice-box" disabled={configurationLocked}>
              <legend>Monde à démarrer <b>requis</b></legend>
              <div className="world-choice-grid" role="radiogroup" aria-label="Monde à démarrer">
                <button
                  type="button"
                  role="radio"
                  aria-checked={!selectedWorldId}
                  className={`world-choice-card ${!selectedWorldId ? 'is-selected' : ''}`}
                  onClick={onChooseNewWorld}
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
                    onClick={() => onChooseWorld(world, false)}
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
                <input value={configuration.serverName} maxLength={64} disabled={configurationLocked} onChange={(event) => onChangeField('serverName', event.target.value)} className="nether-input" required />
              </label>
              {selectedWorld ? (
                <div className="nether-field">
                  <span>Monde existant · progression conservée</span>
                  <div className="world-selected-summary"><strong>{selectedWorld.name}</strong><small>BDS {selectedWorld.version} · dossier isolé</small></div>
                </div>
              ) : (
                <label className="nether-field">
                  <span>Nom du nouveau monde</span>
                  <input value={newWorldName} maxLength={64} disabled={configurationLocked} onChange={(event) => onNewWorldNameChange(event.target.value)} className="nether-input" required />
                </label>
              )}
              <div className="nether-field deploy-segment-field">
                <span id="deploy-gamemode-label">Mode de jeu</span>
                <RubberSegment
                  options={gameModeOptions}
                  value={configuration.gamemode}
                  onChange={(value) => onChangeField('gamemode', value)}
                  labelledBy="deploy-gamemode-label"
                  disabled={configurationLocked}
                />
              </div>
              <div className="nether-field deploy-segment-field">
                <span id="deploy-difficulty-label">Difficulté</span>
                <RubberSegment
                  options={difficultyOptions}
                  value={configuration.difficulty}
                  onChange={(value) => onChangeField('difficulty', value)}
                  labelledBy="deploy-difficulty-label"
                  disabled={configurationLocked}
                />
              </div>
              <label className="nether-field">
                <span>Joueurs maximum</span>
                <input type="number" min={1} step={1} value={configuration.maxPlayers} disabled={configurationLocked} onChange={(event) => onChangeField('maxPlayers', Number(event.target.value))} className="nether-input" required />
              </label>
              <div className="nether-field deploy-seed-field">
                <label className="deploy-seed-field__label" htmlFor="deploy-seed">Seed <small>{selectedWorld ? 'verrouillée · monde déjà généré' : 'optionnelle · vide = aléatoire'}</small></label>
                <input id="deploy-seed" value={configuration.seed} maxLength={80} disabled={configurationLocked || Boolean(selectedWorld)} onChange={(event) => onChangeField('seed', event.target.value)} className="nether-input" />
                <SeedTools seed={configuration.seed} onCopy={(seed) => { void onCopy(seed, 'Seed'); }} />
              </div>
              <label className="nether-field">
                <span>Distance de vue <small>chunks</small></span>
                <input type="number" min={1} max={96} step={1} value={configuration.viewDistance} disabled={configurationLocked} onChange={(event) => onChangeField('viewDistance', Number(event.target.value))} className="nether-input" />
              </label>
            </div>

            <div className="admin-xuid-box">
              <div className="admin-xuid-box__header">
                <div><strong>Administrateurs Bedrock</strong><small>1 à 3 XUID numériques uniques · aucun gamertag</small></div>
                <motion.button type="button" onClick={onAddAdminField} disabled={adminXuidsLocked || configuration.adminXuids.length >= 3} whileTap={reduceMotion ? undefined : { scale: 0.95 }} className="nether-btn nether-btn--tiny nether-btn--quiet">
                  <Users size={14} /> Ajouter
                </motion.button>
              </div>
              {!canAdmin && (
                <p className="nether-inline-note"><ShieldCheck size={14} />Seuls les comptes admin ou propriétaire peuvent définir ou modifier les XUID administrateurs Bedrock.</p>
              )}
              <div className="admin-xuid-list">
                {configuration.adminXuids.map((xuid, index) => (
                  <div key={index} className="admin-xuid-row">
                    <span className="admin-xuid-row__number">{String(index + 1).padStart(2, '0')}</span>
                    <input aria-label={`XUID administrateur ${index + 1}`} inputMode="numeric" autoComplete="off" value={xuid} disabled={adminXuidsLocked} onChange={(event) => onSetAdminXuid(index, event.target.value)} className="nether-input" placeholder="Ex. 2535412894129841" required />
                    {configuration.adminXuids.length > 1 && <button type="button" onClick={() => onRemoveAdminField(index)} disabled={adminXuidsLocked} className="icon-button icon-button--danger" aria-label={`Retirer le XUID ${index + 1}`}><X size={16} /></button>}
                  </div>
                ))}
              </div>
              {configuration.adminXuids.some((xuid) => xuid.length > 0 && !/^\d{1,20}$/.test(xuid)) && <p className="inline-error">Le XUID doit contenir uniquement des chiffres, sans espace.</p>}
              {configuration.adminXuids.every((xuid) => xuid.length > 0) && new Set(configuration.adminXuids).size !== configuration.adminXuids.length && <p className="inline-error">Chaque XUID administrateur doit être unique.</p>}
              <XuidConverter onCopy={onCopy} />
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
                  onChange={(allowCheats) => onChangeField('allowCheats', allowCheats)}
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
              onChange={(checked) => onChangeField('eulaAccepted', checked)}
              disabled={configurationLocked}
            >
              J’ai lu et j’accepte l’<a href="https://www.minecraft.net/eula" target="_blank" rel="noreferrer">EULA Minecraft</a>. Si le binaire affiche un prompt connu, le backend y répondra automatiquement; aucun fichier EULA non vérifié ne sera inventé.
            </SpringCheck>

            <motion.button
              type={isEditingWorldSettings || (isExistingDeployment && !operationNeedsDeploy) ? 'button' : 'submit'}
              onClick={isEditingWorldSettings
                ? onSaveWorldSettings
                : isExistingDeployment && !operationNeedsDeploy ? onSaveConfiguration : undefined}
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
  );
}

export default DeployPanel;
