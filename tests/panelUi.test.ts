import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { register } from 'node:module';
import path from 'node:path';
import { createElement as h, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';
import type {
  AuthStatus,
  DeployConfiguration,
  ManagedWorld,
  SnapshotManagerSnapshot,
} from '../src/types/backend.ts';

register(
  `data:text/javascript,${encodeURIComponent(
    'export async function load(url, context, nextLoad) { if (url.endsWith(".css")) return { format: "module", shortCircuit: true, source: "export default {};" }; return nextLoad(url, context); }',
  )}`,
  import.meta.url,
);

const { DialogProvider } = await import('../src/components/DialogProvider.tsx');
const { OperationsView } = await import('../src/views/OperationsView.tsx');
const { DeployPanel } = await import('../src/views/panel/DeployPanel.tsx');
const { PanelLoginView } = await import('../src/views/panel/PanelLoginView.tsx');
const { WorldsPanel } = await import('../src/views/panel/WorldsPanel.tsx');
const {
  defaultConfiguration,
  formatBytes,
  formatDuration,
  getWorldSettingsConfirmation,
  hasConfigurationSettingsChanged,
  haveSameConsoleLogIds,
  isValidForm,
  panelTabFromHash,
} = await import('../src/views/panel/panelHelpers.ts');

function validConfiguration(): DeployConfiguration {
  return {
    ...defaultConfiguration,
    version: '1.21.130.4',
    serverName: 'Nebula Test',
    levelName: 'WorldFolder',
    adminXuids: ['2535412894129841'],
    eulaAccepted: true,
  };
}

function sampleWorld(overrides: Partial<ManagedWorld> = {}): ManagedWorld {
  return {
    id: 'world-1',
    name: 'Monde Survie',
    folder: 'WorldFolder',
    version: '1.21.130.4',
    seed: '99887766',
    source: 'created',
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    lastUsedAt: '2026-10-02T10:00:00.000Z',
    configuration: validConfiguration(),
    status: 'ready',
    sizeBytes: 42 * 1024 * 1024,
    lastModifiedAt: '2026-10-02T10:00:00.000Z',
    ...overrides,
  };
}

test('panelHelpers validate hashes, byte/duration formatting, and deploy configurations', () => {
  assert.equal(panelTabFromHash('#overview'), 'overview');
  assert.equal(panelTabFromHash('#operations'), 'operations');
  assert.equal(panelTabFromHash('#pixel-studio'), 'pixel-studio');
  assert.equal(panelTabFromHash('#unknown-tab'), null);

  assert.equal(formatBytes(null), 'inconnu');
  assert.equal(formatBytes(512), '512 o');
  assert.equal(formatBytes(2048), '2.0 Kio');
  assert.equal(formatBytes(42 * 1024 * 1024), '42 Mio');
  assert.equal(formatBytes(2 * 1024 ** 3), '2.0 Go');

  assert.equal(formatDuration(null), '—');
  assert.equal(formatDuration(3661), '01:01:01');
  assert.equal(formatDuration(90061), '1 j 01:01:01');

  const valid = validConfiguration();
  assert.equal(isValidForm(valid), true);
  assert.equal(isValidForm({ ...valid, eulaAccepted: false }), false);
  assert.equal(isValidForm({ ...valid, adminXuids: ['2535412894129841', '2535412894129841'] }), false);
  assert.equal(isValidForm({ ...valid, adminXuids: ['not-a-xuid'] }), false);

  assert.equal(hasConfigurationSettingsChanged(valid, { ...valid }), false);
  assert.equal(hasConfigurationSettingsChanged(valid, { ...valid, maxPlayers: 20 }), true);
  assert.equal(getWorldSettingsConfirmation(valid, { ...valid }), null);
  assert.match(getWorldSettingsConfirmation(valid, { ...valid, levelName: 'OtherFolder' }) ?? '', /worlds\/OtherFolder/);

  const lineA = { id: '1', timestamp: '2026-11-01T00:00:00.000Z', level: 'info' as const, tag: 'BDS', message: 'Ready' };
  assert.equal(haveSameConsoleLogIds([lineA], [{ ...lineA }]), true);
  assert.equal(haveSameConsoleLogIds([lineA], [{ ...lineA, id: '2' }]), false);
});

test('PanelLoginView renders unconfigured warning, credential labels, and error alerts', () => {
  const unconfiguredAuth: AuthStatus = {
    configured: false,
    authenticated: false,
    role: null,
    username: null,
  };
  const unconfiguredMarkup = renderToStaticMarkup(h(PanelLoginView, {
    authStatus: unconfiguredAuth,
    reduceMotion: true,
    loginUsername: '',
    onUsernameChange: () => undefined,
    token: '',
    onTokenChange: () => undefined,
    showToken: false,
    onToggleShowToken: () => undefined,
    loginBusy: false,
    loginError: '',
    onSubmit: () => undefined,
  }));
  assert.match(unconfiguredMarkup, /PANEL_TOKEN n’est pas configuré/);
  assert.match(unconfiguredMarkup, /Jeton du panneau/);

  const accountLoginMarkup = renderToStaticMarkup(h(PanelLoginView, {
    authStatus: { configured: true, authenticated: false, role: null, username: null },
    reduceMotion: true,
    loginUsername: 'alice',
    onUsernameChange: () => undefined,
    token: 'secret',
    onTokenChange: () => undefined,
    showToken: false,
    onToggleShowToken: () => undefined,
    loginBusy: false,
    loginError: 'Identifiants refusés.',
    onSubmit: () => undefined,
  }));
  assert.match(accountLoginMarkup, /Mot de passe du compte/);
  assert.match(accountLoginMarkup, /Identifiants refusés\./);
});

test('DeployPanel enforces strict RBAC by locking adminXuids editing for non-admin operators', () => {
  const config = validConfiguration();
  const baseProps = {
    reduceMotion: true,
    animatePanelEntry: false,
    isExistingDeployment: true,
    bedrockMayBeRunning: false,
    configurationLocked: false,
    deploymentVersionOptions: [{ value: '1.21.130.4', label: 'BDS 1.21.130.4', tag: 'Client 1.21.130' }],
    configuration: config,
    selectedVersion: {
      version: '1.21.130.4',
      label: 'BDS 1.21.130.4',
      channel: 'stable' as const,
      clientVersion: '1.21.130',
      releaseDate: '2026-01-15',
    },
    versionsCount: 1,
    selectedWorldId: 'world-1',
    selectedWorld: sampleWorld(),
    worldsForSelectedVersion: [sampleWorld()],
    newWorldName: 'Nouveau monde',
    isPipelineBusy: false,
    isEditingWorldSettings: false,
    editingWorld: undefined,
    worldBusyId: null,
    operationNeedsDeploy: false,
    configurationActionDisabled: false,
    configurationActionLabel: 'Enregistrer les réglages',
    onDeploySubmit: () => undefined,
    onSaveWorldSettings: () => undefined,
    onSaveConfiguration: () => undefined,
    onChangeField: () => undefined,
    onChooseNewWorld: () => undefined,
    onChooseWorld: () => undefined,
    onNewWorldNameChange: () => undefined,
    onAddAdminField: () => undefined,
    onSetAdminXuid: () => undefined,
    onRemoveAdminField: () => undefined,
    onCopy: () => undefined,
  };

  const operatorMarkup = renderToStaticMarkup(h(DeployPanel, { ...baseProps, canAdmin: false }));
  assert.match(operatorMarkup, /Seuls les comptes admin ou propriétaire peuvent définir ou modifier les XUID/);
  assert.match(operatorMarkup, /aria-label="XUID administrateur 1"[^>]*disabled=""/);

  const adminMarkup = renderToStaticMarkup(h(DeployPanel, { ...baseProps, canAdmin: true }));
  assert.doesNotMatch(adminMarkup, /Seuls les comptes admin ou propriétaire peuvent définir ou modifier les XUID/);
  assert.doesNotMatch(adminMarkup, /aria-label="XUID administrateur 1"[^>]*disabled=""/);
});

test('WorldsPanel renders computed sizeBytes and gates seed, export, and delete actions by role', () => {
  const world = sampleWorld();
  const baseProps = {
    reduceMotion: true,
    animatePanelEntry: false,
    configurationVersion: '1.21.130.4',
    versionsAvailable: true,
    isValidImportVersion: true,
    worlds: [world],
    activeWorld: world,
    startDisabled: false,
    worldManagerError: '',
    worldVersionOptions: [{ value: '1.21.130.4', label: 'BDS 1.21.130.4' }],
    worldImportVersion: '1.21.130.4',
    worldImportName: '',
    worldImportFile: null,
    worldImportInputRef: createRef<HTMLInputElement>(),
    worldBusyId: null,
    renameWorldId: null,
    renameWorldValue: '',
    assignWorldVersion: {},
    worldSwipeNonce: {},
    packWorldId: '',
    packWorld: undefined,
    readyPackWorlds: [world],
    packImportLocked: true,
    packMutationLocked: true,
    worldPackFile: null,
    worldPackInputRef: createRef<HTMLInputElement>(),
    worldPackLoading: false,
    worldPacks: [],
    onRefreshWorlds: () => undefined,
    onSetWorldImportVersion: () => undefined,
    onSetWorldImportName: () => undefined,
    onSelectWorldImportFile: () => undefined,
    onImportWorld: () => undefined,
    onChooseNewWorld: () => undefined,
    onChooseWorld: () => undefined,
    onStartServer: () => undefined,
    onExportWorld: () => undefined,
    onStartRenameWorld: () => undefined,
    onCancelRenameWorld: () => undefined,
    onChangeRenameWorldValue: () => undefined,
    onCommitRenameWorld: () => undefined,
    onChangeAssignWorldVersion: () => undefined,
    onAssignWorld: () => undefined,
    onDeleteWorld: async () => false,
    onResetWorldSwipe: () => undefined,
    onCopy: () => undefined,
    onSetPackWorldId: () => undefined,
    onSelectWorldPackFile: () => undefined,
    onImportPack: () => undefined,
    onTogglePack: () => undefined,
  };

  const viewerMarkup = renderToStaticMarkup(h(WorldsPanel, {
    ...baseProps,
    worlds: [sampleWorld({ seed: null })],
    canOperate: false,
    canAdmin: false,
    configurationLocked: true,
  }));
  assert.match(viewerMarkup, /42 Mio/);
  assert.match(viewerMarkup, /Masquée · rôle viewer/);
  assert.doesNotMatch(viewerMarkup, /Exporter/);
  assert.doesNotMatch(viewerMarkup, /> Supprimer</);

  const operatorMarkup = renderToStaticMarkup(h(WorldsPanel, {
    ...baseProps,
    canOperate: true,
    canAdmin: false,
    configurationLocked: false,
  }));
  assert.match(operatorMarkup, /99887766/);
  assert.match(operatorMarkup, /Exporter/);
  assert.doesNotMatch(operatorMarkup, /> Supprimer</);

  const adminMarkup = renderToStaticMarkup(h(WorldsPanel, {
    ...baseProps,
    canOperate: true,
    canAdmin: true,
    configurationLocked: false,
  }));
  assert.match(adminMarkup, /Exporter/);
  assert.match(adminMarkup, /> Supprimer</);
});

test('OperationsView hides snapshot download links for viewer and exposes them to operator', () => {
  const world = sampleWorld();
  const snapshots: SnapshotManagerSnapshot = {
    settings: {
      enabled: false,
      intervalHours: 24,
      retentionPerWorld: 3,
      maxStorageBytes: 10 * 1024 ** 3,
      lastRunAt: null,
      nextRunAt: null,
      lastError: null,
    },
    storageUsedBytes: 1024 * 1024,
    diskFreeBytes: 20 * 1024 ** 3,
    diskWarning: false,
    snapshots: [
      {
        id: 'snap-1234567890',
        worldId: world.id,
        worldName: world.name,
        createdAt: '2026-10-15T09:30:00.000Z',
        reason: 'manual',
        sizeBytes: 1024 * 1024,
      },
    ],
  };

  const viewerHtml = renderToStaticMarkup(
    h(DialogProvider, null, h(OperationsView, {
      role: 'viewer',
      authStatus: { configured: true, authenticated: true, role: 'viewer', username: 'lecteur' },
      worlds: [world],
      state: null,
      system: null,
      snapshots,
      recovery: null,
      monitoring: null,
      refreshStatus: async () => undefined,
      onNotify: () => undefined,
    })),
  );
  assert.doesNotMatch(viewerHtml, /\/api\/server\/snapshots\/snap-1234567890\/download/);

  const operatorHtml = renderToStaticMarkup(
    h(DialogProvider, null, h(OperationsView, {
      role: 'operator',
      authStatus: { configured: true, authenticated: true, role: 'operator', username: 'operateur' },
      worlds: [world],
      state: null,
      system: null,
      snapshots,
      recovery: null,
      monitoring: null,
      refreshStatus: async () => undefined,
      onNotify: () => undefined,
    })),
  );
  assert.match(operatorHtml, /\/api\/server\/snapshots\/snap-1234567890\/download/);
});

test('frontend sources preserve brand mark orientation, DialogProvider confirmations, and zero Google Fonts links', async () => {
  const [indexHtml, livePanelSource, operationsSource] = await Promise.all([
    readFile(path.resolve('index.html'), 'utf8'),
    readFile(path.resolve('src/views/LivePanelView.tsx'), 'utf8'),
    readFile(path.resolve('src/views/OperationsView.tsx'), 'utf8'),
  ]);
  assert.doesNotMatch(indexHtml, /fonts\.googleapis\.com|fonts\.gstatic\.com/);
  assert.doesNotMatch(livePanelSource, /rotate\s*:/);
  assert.doesNotMatch(operationsSource, /window\.confirm/);
});

