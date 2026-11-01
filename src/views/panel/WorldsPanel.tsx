import type { RefObject } from 'react';
import { motion } from 'motion/react';
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Database,
  Download,
  FileUp,
  Globe,
  Layers,
  Loader2,
  Package,
  Pencil,
  Play,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { GlideSelect, type GlideSelectOption } from '../../components/GlideSelect.tsx';
import { NetherCard } from '../../components/NetherCard.tsx';
import { SeedTools } from '../../components/SeedTools.tsx';
import SwipeRow from '../../components/SwipeRow.jsx';
import type { ManagedBedrockPack, ManagedWorld } from '../../types/backend.ts';
import { formatBytes } from './panelHelpers.ts';
import { PanelHeading, StatusPill } from './PanelPrimitives.tsx';

export interface WorldsPanelProps {
  reduceMotion: boolean;
  animatePanelEntry: boolean;
  canOperate: boolean;
  canAdmin: boolean;
  configurationLocked: boolean;
  configurationVersion: string;
  versionsAvailable: boolean;
  isValidImportVersion: boolean;
  worlds: ManagedWorld[];
  activeWorld: ManagedWorld | undefined;
  startDisabled: boolean;
  worldManagerError: string;
  worldVersionOptions: GlideSelectOption[];
  worldImportVersion: string;
  worldImportName: string;
  worldImportFile: File | null;
  worldImportInputRef: RefObject<HTMLInputElement | null>;
  worldBusyId: string | null;
  renameWorldId: string | null;
  renameWorldValue: string;
  assignWorldVersion: Record<string, string>;
  worldSwipeNonce: Record<string, number>;
  packWorldId: string;
  packWorld: ManagedWorld | undefined;
  readyPackWorlds: ManagedWorld[];
  packImportLocked: boolean;
  packMutationLocked: boolean;
  worldPackFile: File | null;
  worldPackInputRef: RefObject<HTMLInputElement | null>;
  worldPackLoading: boolean;
  worldPacks: ManagedBedrockPack[];
  onRefreshWorlds: () => void;
  onSetWorldImportVersion: (value: string) => void;
  onSetWorldImportName: (value: string) => void;
  onSelectWorldImportFile: (file: File | null) => void;
  onImportWorld: () => void;
  onChooseNewWorld: () => void;
  onChooseWorld: (world: ManagedWorld, editSettings: boolean) => void;
  onStartServer: () => void;
  onExportWorld: (world: ManagedWorld) => void;
  onStartRenameWorld: (world: ManagedWorld) => void;
  onCancelRenameWorld: () => void;
  onChangeRenameWorldValue: (value: string) => void;
  onCommitRenameWorld: (world: ManagedWorld) => void;
  onChangeAssignWorldVersion: (worldId: string, version: string) => void;
  onAssignWorld: (world: ManagedWorld) => void;
  onDeleteWorld: (world: ManagedWorld) => Promise<boolean>;
  onResetWorldSwipe: (worldId: string) => void;
  onCopy: (value: string, label: string) => Promise<void> | void;
  onSetPackWorldId: (worldId: string) => void;
  onSelectWorldPackFile: (file: File | null) => void;
  onImportPack: () => void;
  onTogglePack: (pack: ManagedBedrockPack) => void;
}

export function WorldsPanel({
  reduceMotion,
  animatePanelEntry,
  canOperate,
  canAdmin,
  configurationLocked,
  configurationVersion,
  versionsAvailable,
  isValidImportVersion,
  worlds,
  activeWorld,
  startDisabled,
  worldManagerError,
  worldVersionOptions,
  worldImportVersion,
  worldImportName,
  worldImportFile,
  worldImportInputRef,
  worldBusyId,
  renameWorldId,
  renameWorldValue,
  assignWorldVersion,
  worldSwipeNonce,
  packWorldId,
  packWorld,
  readyPackWorlds,
  packImportLocked,
  packMutationLocked,
  worldPackFile,
  worldPackInputRef,
  worldPackLoading,
  worldPacks,
  onRefreshWorlds,
  onSetWorldImportVersion,
  onSetWorldImportName,
  onSelectWorldImportFile,
  onImportWorld,
  onChooseNewWorld,
  onChooseWorld,
  onStartServer,
  onExportWorld,
  onStartRenameWorld,
  onCancelRenameWorld,
  onChangeRenameWorldValue,
  onCommitRenameWorld,
  onChangeAssignWorldVersion,
  onAssignWorld,
  onDeleteWorld,
  onResetWorldSwipe,
  onCopy,
  onSetPackWorldId,
  onSelectWorldPackFile,
  onImportPack,
  onTogglePack,
}: WorldsPanelProps) {
  return (
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
          <motion.button type="button" onClick={onRefreshWorlds} disabled={configurationLocked} whileTap={reduceMotion ? undefined : { scale: 0.96 }} className="nether-btn nether-btn--quiet nether-btn--tiny">
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
                options={worldVersionOptions}
                value={worldImportVersion}
                onChange={onSetWorldImportVersion}
                labelledBy="world-import-version-label"
                disabled={configurationLocked || !versionsAvailable}
                required
                invalid={!isValidImportVersion}
              />
            </div>
            <label className="nether-field">
              <span>Nom dans le gestionnaire</span>
              <input value={worldImportName} maxLength={80} disabled={configurationLocked} onChange={(event) => onSetWorldImportName(event.target.value)} className="nether-input" placeholder={worldImportFile?.name.replace(/\.(mcworld|zip)$/i, '') || 'Nom du monde'} />
            </label>
            <label className="nether-field world-file-field">
              <span>Archive Bedrock</span>
              <input
                ref={worldImportInputRef}
                type="file"
                accept=".mcworld,.zip,application/zip,application/octet-stream"
                disabled={configurationLocked}
                onChange={(event) => onSelectWorldImportFile(event.target.files?.[0] ?? null)}
                className="world-file-input"
              />
            </label>
            <motion.button type="button" onClick={onImportWorld} disabled={configurationLocked || !worldImportFile || !worldImportVersion || worldBusyId === 'import'} whileTap={reduceMotion ? undefined : { scale: 0.97 }} className="nether-btn nether-btn--primary world-import-submit">
              {worldBusyId === 'import' ? <Loader2 className="spin-soft" size={16} /> : <FileUp size={16} />}
              {worldBusyId === 'import' ? 'Import en cours…' : 'Importer sans remplacer'}
            </motion.button>
          </div>
          <p className="world-import-footnote">L’archive est vérifiée et extraite avec des limites de taille; un dossier temporaire est utilisé. Le monde n’est ajouté à la liste qu’après validation, et tout nom de dossier est généré côté serveur.</p>
        </div>

        {worlds.length === 0 ? (
          <div className="world-manager-empty">
            <Globe size={25} />
            <strong>Aucune sauvegarde enregistrée</strong>
            <span>Crée un monde depuis le déploiement ou importe une archive Bedrock.</span>
            <button type="button" className="world-manager-empty__link" onClick={onChooseNewWorld}>
              Créer le premier monde <ChevronRight size={14} />
            </button>
          </div>
        ) : (
          <div className="world-manager-list">
            {worlds.map((world) => {
              const isCurrent = activeWorld?.id === world.id;
              const sourceLabel = world.source === 'imported' ? 'Importé' : world.source === 'legacy' ? 'Existant' : 'Créé par N-Craft';
              const statusLabelText = world.status === 'ready' ? 'PRÊT' : world.status === 'pending' ? 'À INITIALISER' : world.status === 'missing' ? 'DOSSIER ABSENT' : world.status === 'unsafe' ? 'INACCESSIBLE' : 'VERSION À ASSOCIER';
              const statusTone = world.status === 'ready' ? 'running' : world.status === 'missing' || world.status === 'unsafe' ? 'failed' : 'starting';
              const seedText = !canOperate
                ? 'Masquée · rôle viewer'
                : world.seed === null
                  ? 'Inconnue · non modifiable'
                  : world.seed || 'Aléatoire';

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
                    disabled={!canAdmin || configurationLocked || worldBusyId === world.id || renameWorldId === world.id}
                    onCommit={(action) => {
                      if (action.id !== 'delete') return;
                      void onDeleteWorld(world).then((deleted) => {
                        if (!deleted) onResetWorldSwipe(world.id);
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
                            <input id={`world-name-${world.id}`} value={renameWorldValue} maxLength={80} onChange={(event) => onChangeRenameWorldValue(event.target.value)} className="nether-input" autoFocus />
                            <button type="button" className="icon-button" aria-label="Enregistrer le nom" disabled={worldBusyId === world.id || configurationLocked} onClick={() => onCommitRenameWorld(world)}><Check size={15} /></button>
                            <button type="button" className="icon-button" aria-label="Annuler le renommage" onClick={onCancelRenameWorld}><X size={15} /></button>
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
                    <span className="managed-world__seed-detail">
                      <small>Seed</small>
                      <strong>{seedText}</strong>
                      {canOperate && world.seed !== null && world.seed.trim() && (
                        <SeedTools seed={world.seed} copyLabel={`Copier la seed de ${world.name}`} onCopy={(seed) => { void onCopy(seed, `Seed de « ${world.name} »`); }} />
                      )}
                    </span>
                    {world.sizeBytes !== null && <span><small>Taille sur disque</small><strong>{formatBytes(world.sizeBytes)}</strong></span>}
                    <span><small>Dernière utilisation</small><strong>{world.lastUsedAt ? new Date(world.lastUsedAt).toLocaleString('fr-FR') : 'Jamais démarré ici'}</strong></span>
                    {world.lastModifiedAt && <span><small>level.dat modifié</small><strong>{new Date(world.lastModifiedAt).toLocaleDateString('fr-FR')}</strong></span>}
                  </div>

                  {world.status === 'unassigned' && (
                    <div className="world-assign-row">
                      <div className="nether-field">
                        <span id={`assign-version-label-${world.id}`}>Attribuer la version d’origine</span>
                        <GlideSelect
                          options={worldVersionOptions}
                          value={assignWorldVersion[world.id] ?? configurationVersion}
                          onChange={(value) => onChangeAssignWorldVersion(world.id, value)}
                          labelledBy={`assign-version-label-${world.id}`}
                          disabled={configurationLocked || worldBusyId === world.id}
                          placeholder="Choisir la version exacte…"
                          required
                        />
                      </div>
                      <button type="button" className="nether-btn nether-btn--quiet" onClick={() => onAssignWorld(world)} disabled={configurationLocked || worldBusyId === world.id}><Check size={15} /> Associer</button>
                    </div>
                  )}

                  <div className="managed-world__actions">
                    <button type="button" className="nether-btn nether-btn--primary nether-btn--tiny" onClick={() => (isCurrent ? onStartServer() : onChooseWorld(world, false))} disabled={configurationLocked || world.status !== 'ready' || !world.version || (isCurrent && startDisabled)}>
                      <Play size={14} /> {isCurrent ? 'Démarrer ce monde' : 'Choisir & reprendre'}
                    </button>
                    <button type="button" className="nether-btn nether-btn--quiet nether-btn--tiny" onClick={() => onChooseWorld(world, true)} disabled={configurationLocked || !world.version || world.status === 'missing' || world.status === 'unsafe'}>
                      <Pencil size={14} /> Modifier les options
                    </button>
                    {canOperate && (
                      <button type="button" className="nether-btn nether-btn--quiet nether-btn--tiny" onClick={() => onExportWorld(world)} disabled={configurationLocked || world.status !== 'ready'}>
                        <Download size={14} /> Exporter
                      </button>
                    )}
                    {renameWorldId !== world.id && (
                      <button type="button" className="nether-btn nether-btn--quiet nether-btn--tiny" onClick={() => onStartRenameWorld(world)} disabled={configurationLocked}>
                        <Pencil size={14} /> Renommer
                      </button>
                    )}
                    {canAdmin && (
                      <button type="button" className="nether-btn nether-btn--danger nether-btn--tiny" onClick={() => { void onDeleteWorld(world); }} disabled={configurationLocked || worldBusyId === world.id}>
                        {worldBusyId === world.id ? <Loader2 className="spin-soft" size={14} /> : <Trash2 size={14} />} Supprimer
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </NetherCard>

      <NetherCard
        title="Packs Bedrock"
        eyebrow="RESSOURCES & COMPORTEMENTS · PAR MONDE"
        description="Importe un pack de ressources ou de comportement, puis active-le séparément pour chaque monde. Les fichiers désactivés restent installés."
        icon={Layers}
        accent="portal"
        className="world-manager-card"
      >
        <div className="world-pack-target">
          <label className="nether-field" htmlFor="world-pack-target">
            <span>Monde cible</span>
            <select
              id="world-pack-target"
              className="nether-input"
              value={packWorldId}
              onChange={(event) => onSetPackWorldId(event.target.value)}
              disabled={readyPackWorlds.length === 0}
            >
              <option value="">Choisir un monde prêt…</option>
              {readyPackWorlds.map((world) => <option key={world.id} value={world.id}>{world.name} · BDS {world.version}</option>)}
            </select>
          </label>
          <p className="world-import-footnote">L’activation écrit uniquement la liste de packs du monde choisi. Vérifie la compatibilité avec le BDS et les modules Script API; Bedrock doit être arrêté. Aucun pack ni réglage n’est supprimé lors de l’import.</p>
        </div>

        {canAdmin ? (
          <div className="world-import-panel">
            <div className="world-import-panel__heading"><span className="world-import-icon"><FileUp size={17} /></span><div><strong>Importer un pack</strong><small>.mcpack, ou ZIP/.mcaddon contenant un seul pack · 256 Mio max</small></div></div>
            <div className="world-pack-import-row">
              <label className="nether-field world-file-field">
                <span>Archive du pack</span>
                <input
                  ref={worldPackInputRef}
                  type="file"
                  accept=".mcpack,.mcaddon,.zip,application/zip,application/octet-stream"
                  disabled={packImportLocked}
                  onChange={(event) => onSelectWorldPackFile(event.target.files?.[0] ?? null)}
                  className="world-file-input"
                />
              </label>
              <button
                type="button"
                onClick={onImportPack}
                disabled={packImportLocked || !worldPackFile}
                className="nether-btn nether-btn--primary"
              >
                {worldBusyId === 'pack-import' ? <Loader2 className="spin-soft" size={16} /> : <FileUp size={16} />}
                {worldBusyId === 'pack-import' ? 'Import en cours…' : 'Importer le pack'}
              </button>
            </div>
            <p className="world-import-footnote">Les archives sont extraites avec contrôle des chemins, des liens symboliques, du nombre de fichiers et de la taille décompressée. Une archive multi-pack est refusée; les dépendances de packs UUID doivent être installées et activées avant le pack qui en dépend.</p>
          </div>
        ) : (
          <p className="nether-inline-note"><ShieldCheck size={14} />L’import et l’activation de packs sont réservés aux comptes admin ou propriétaire.</p>
        )}

        {!packWorldId ? (
          <div className="world-manager-empty"><Layers size={24} /><strong>Choisis un monde prêt</strong><span>Les packs sont activés monde par monde; un pack importé n’est pas activé automatiquement.</span></div>
        ) : worldPackLoading ? (
          <p className="nether-inline-note" role="status"><Loader2 className="spin-soft" size={14} /> Lecture des packs de « {packWorld?.name ?? 'ce monde'} »…</p>
        ) : worldPacks.length === 0 ? (
          <div className="world-manager-empty"><Package size={24} /><strong>Aucun pack Bedrock détecté</strong><span>Importe un .mcpack ou un ZIP contenant un seul manifest.json.</span></div>
        ) : (
          <div className="world-pack-list" aria-label={`Packs du monde ${packWorld?.name ?? ''}`}>
            {worldPacks.map((pack) => (
              <article key={pack.uuid} className="world-pack-row">
                <div className="world-pack-row__details">
                  <strong>{pack.name}</strong>
                  <small>{pack.kind === 'resource' ? 'Pack de ressources' : 'Pack de comportement'} · v{pack.version.join('.')} · {pack.active ? 'Actif dans ce monde' : 'Installé, inactif'}</small>
                  {pack.description && <span>{pack.description}</span>}
                </div>
                {canAdmin && (
                  <button
                    type="button"
                    className={`nether-btn ${pack.active ? 'nether-btn--quiet' : 'nether-btn--primary'} nether-btn--tiny`}
                    onClick={() => onTogglePack(pack)}
                    disabled={packMutationLocked || worldBusyId === `pack-${pack.uuid}`}
                    aria-pressed={pack.active}
                    aria-label={`${pack.active ? 'Désactiver' : 'Activer'} ${pack.name} pour ${packWorld?.name ?? 'ce monde'}`}
                  >
                    {worldBusyId === `pack-${pack.uuid}` ? <Loader2 className="spin-soft" size={14} /> : pack.active ? <X size={14} /> : <Check size={14} />}
                    {pack.active ? 'Désactiver' : 'Activer'}
                  </button>
                )}
              </article>
            ))}
          </div>
        )}
      </NetherCard>
    </motion.div>
  );
}

export default WorldsPanel;
