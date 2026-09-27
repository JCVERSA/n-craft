import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, lstat, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helperSource = path.join(projectRoot, 'scripts', 'env-manager.mjs');
const exampleSource = path.join(projectRoot, '.env.example');

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ncraft-env-test-'));
  await mkdir(path.join(root, 'scripts'));
  await copyFile(helperSource, path.join(root, 'scripts', 'env-manager.mjs'));
  await copyFile(exampleSource, path.join(root, '.env.example'));
  return root;
}

function invoke(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'env-manager.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5_000,
  });
}

test('env init generates a private token and preserves an existing .env', async (t) => {
  const root = await createFixture();
  t.after(async () => rm(root, { recursive: true, force: true }));
  const envPath = path.join(root, '.env');

  let result = invoke(root, 'init');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\.env créé/);
  let content = await readFile(envPath, 'utf8');
  const generatedToken = content.match(/^PANEL_TOKEN=(.+)$/m)?.[1];
  assert.ok(generatedToken);
  assert.equal(generatedToken.length, 64);
  assert.doesNotMatch(result.stdout, new RegExp(generatedToken));
  assert.equal((await stat(envPath)).mode & 0o777, 0o600);

  content = `# local operator settings\nPORT=32123\nPANEL_TOKEN=${generatedToken}\nCUSTOM_FLAG=kept\n`;
  await writeFile(envPath, content, { mode: 0o600 });
  await chmod(envPath, 0o600);
  const inodeBeforeInit = (await stat(envPath)).ino;
  result = invoke(root, 'init');
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await stat(envPath)).ino, inodeBeforeInit, 'a valid existing .env must not be rewritten');
  const preserved = await readFile(envPath, 'utf8');
  assert.match(preserved, /^# local operator settings$/m);
  assert.match(preserved, /^PORT=32123$/m);
  assert.match(preserved, new RegExp(`^PANEL_TOKEN=${generatedToken}$`, 'm'));
  assert.match(preserved, /^CUSTOM_FLAG=kept$/m);

  const emptyRoot = await createFixture();
  t.after(async () => rm(emptyRoot, { recursive: true, force: true }));
  await writeFile(path.join(emptyRoot, '.env'), '', { mode: 0o600 });
  result = invoke(emptyRoot, 'init');
  assert.equal(result.status, 0, result.stderr);
  const initializedEmpty = await readFile(path.join(emptyRoot, '.env'), 'utf8');
  assert.match(initializedEmpty, /^PANEL_TOKEN=[0-9a-f]{64}$/m);
  assert.doesNotMatch(initializedEmpty, /Generated automatically/);
});

test('env set/unset preserves unrelated values and masks secrets by default', async (t) => {
  const root = await createFixture();
  t.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, '.env'), '# keep this comment\nPANEL_TOKEN=0123456789abcdef0123456789abcdef\nPLAYIT_SECRET_KEY=0123456789abcdef0123456789abcdef\n', { mode: 0o600 });

  let result = invoke(root, 'set', 'PORT', '32123');
  assert.equal(result.status, 0, result.stderr);
  result = invoke(root, 'set', 'PANEL_ORIGIN', 'https://panel.example.test');
  assert.equal(result.status, 0, result.stderr);
  let content = await readFile(path.join(root, '.env'), 'utf8');
  assert.match(content, /^# keep this comment$/m);
  assert.match(content, /^PORT=32123$/m);
  assert.match(content, /^PANEL_ORIGIN=https:\/\/panel\.example\.test$/m);
  assert.match(content, /^PLAYIT_SECRET_KEY=0123456789abcdef0123456789abcdef$/m);
  assert.equal((await stat(path.join(root, '.env'))).mode & 0o777, 0o600);

  result = invoke(root, 'get', 'PANEL_TOKEN');
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /0123456789abcdef0123456789abcdef/);
  assert.match(result.stdout, /…/);
  result = invoke(root, 'list');
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /0123456789abcdef0123456789abcdef/);

  result = invoke(root, 'set', 'PLAYIT_SECRET_KEY', 'must-not-be-stored');
  assert.notEqual(result.status, 0);
  content = await readFile(path.join(root, '.env'), 'utf8');
  assert.doesNotMatch(content, /must-not-be-stored/);

  result = spawnSync(process.execPath, [path.join(root, 'scripts', 'env-manager.mjs'), 'set-stdin', 'PANEL_TOKEN'], {
    cwd: root,
    input: 'fedcba9876543210fedcba9876543210',
    encoding: 'utf8',
    timeout: 5_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(await readFile(path.join(root, '.env'), 'utf8'), /^PANEL_TOKEN=fedcba9876543210fedcba9876543210$/m);

  result = invoke(root, 'unset', 'PLAYIT_SECRET_KEY');
  assert.equal(result.status, 0, result.stderr);
  content = await readFile(path.join(root, '.env'), 'utf8');
  assert.doesNotMatch(content, /^PLAYIT_SECRET_KEY=/m);
  assert.match(content, /^PORT=32123$/m);
});

test('env refuses to rewrite an existing .env symlink', async (t) => {
  const root = await createFixture();
  t.after(async () => rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'settings', 'panel.env');
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, 'PANEL_TOKEN=0123456789abcdef0123456789abcdef\n', { mode: 0o600 });
  await symlink(target, path.join(root, '.env'));

  const result = invoke(root, 'set', 'PORT', '32124');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /lien symbolique/);
  assert.equal((await lstat(path.join(root, '.env'))).isSymbolicLink(), true);
  const targetContent = await readFile(target, 'utf8');
  assert.equal(targetContent, 'PANEL_TOKEN=0123456789abcdef0123456789abcdef\n');
});
