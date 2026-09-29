import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuditLog } from '../src/audit.ts';

test('persists a bounded, private audit trail with normalized events', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncraft-audit-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const audit = new AuditLog(directory);
  await audit.initialize();
  await Promise.all([
    audit.record({ username: 'operator-test', role: 'operator', userId: 'id-1' }, 'bedrock start requested', 'Manual start\nrequested.'),
    audit.record({ username: 'owner', role: 'owner', userId: null }, 'panel-login', 'Connexion au panneau.'),
  ]);
  await audit.flush();

  const events = audit.list(10);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.action, 'panel-login');
  assert.equal(events[1]?.action, 'bedrock-start-requested');
  assert.equal(events[1]?.detail, 'Manual start requested.');
  assert.equal((await stat(path.join(directory, 'audit.json'))).mode & 0o777, 0o600);

  const restarted = new AuditLog(directory);
  await restarted.initialize();
  assert.deepEqual(restarted.list(1).map((event) => event.actor), ['owner']);
  const persisted = await readFile(path.join(directory, 'audit.json'), 'utf8');
  assert.equal(persisted.includes('password'), false);
});
