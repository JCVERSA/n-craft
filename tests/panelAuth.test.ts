import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Request, Response } from 'express';
import { PanelAuthService } from '../src/auth.ts';

const PANEL_TOKEN = 'arena-test-panel-token-with-at-least-thirty-two-bytes';

function requestWithCookie(cookie: string): Request {
  return { headers: { cookie }, secure: false } as unknown as Request;
}

function fakeResponse(): { response: Response; statusCode: number | null; body: unknown; cookie: string } {
  const result = { statusCode: null as number | null, body: undefined as unknown, cookie: '' };
  const response = {
    setHeader(name: string, value: string) {
      if (name.toLowerCase() === 'set-cookie') result.cookie = value;
      return this;
    },
    status(code: number) {
      result.statusCode = code;
      return this;
    },
    json(body: unknown) {
      result.body = body;
      return this;
    },
  } as unknown as Response;
  return {
    response,
    get statusCode() { return result.statusCode; },
    get body() { return result.body; },
    get cookie() { return result.cookie; },
  };
}

function invokeMiddleware(
  middleware: ReturnType<PanelAuthService['requireRole']>,
  request: Request,
): { statusCode: number | null; nextCalled: boolean } {
  let statusCode: number | null = null;
  let nextCalled = false;
  const response = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json() { return this; },
  } as unknown as Response;
  middleware(request, response, () => { nextCalled = true; });
  return { statusCode, nextCalled };
}

test('panel accounts persist only salted password hashes and enforce live role changes', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncraft-panel-users-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const auth = new PanelAuthService(PANEL_TOKEN, directory);
  await auth.initialize();

  const username = 'ops_user';
  const password = 'a-Long-Test-Password-Never-Persist-This';
  const user = await auth.createUser(username, password, 'operator');
  const file = path.join(directory, 'panel-users.json');
  const saved = await readFile(file, 'utf8');
  assert.equal(saved.includes(password), false);
  assert.match(saved, /passwordHash/);
  assert.match(saved, /salt/);
  assert.equal((await stat(file)).mode & 0o777, 0o600);

  assert.equal(await auth.authenticate({ username: 'OPS_USER', password: password.toLowerCase() }), null, 'passwords remain case-sensitive');
  const principal = await auth.authenticate({ username: 'OPS_USER', password });
  assert.deepEqual(principal, { username, role: 'operator', userId: user.id });
  assert.equal(await auth.authenticate({ username, password: 'wrong-password' }), null);

  const cookieResponse = fakeResponse();
  auth.createSession(cookieResponse.response, { headers: {}, secure: false } as unknown as Request, principal!);
  const cookie = cookieResponse.cookie.split(';', 1)[0]!;
  const sessionRequest = requestWithCookie(cookie);
  assert.equal(auth.getPrincipal(sessionRequest)?.role, 'operator');
  assert.deepEqual(invokeMiddleware(auth.requireRole('operator'), sessionRequest), { statusCode: null, nextCalled: true });
  assert.deepEqual(invokeMiddleware(auth.requireRole('admin'), sessionRequest), { statusCode: 403, nextCalled: false });

  await auth.updateUserRole(user.id, 'admin');
  assert.equal(auth.getPrincipal(sessionRequest)?.role, 'admin', 'role changes apply to sessions already in use');
  assert.deepEqual(invokeMiddleware(auth.requireRole('admin'), sessionRequest), { statusCode: null, nextCalled: true });
  await auth.deleteUser(user.id);
  assert.equal(auth.getPrincipal(sessionRequest), null, 'deleting an account revokes all of its sessions');
});

test('owner privilege comes only from PANEL_TOKEN and cannot be assigned to a local account', async () => {
  const auth = new PanelAuthService(PANEL_TOKEN);
  const owner = await auth.authenticate({ token: PANEL_TOKEN });
  assert.deepEqual(owner, { username: 'owner', role: 'owner', userId: null });
  await assert.rejects(auth.createUser('owner2', 'a-long-test-password', 'owner'), /owner est réservé/i);
});

test('concurrent account creation is serialized and case-insensitive duplicates cannot overwrite users', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncraft-panel-users-concurrent-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const auth = new PanelAuthService(PANEL_TOKEN, directory);
  await auth.initialize();
  const results = await Promise.allSettled([
    auth.createUser('Concurrent', 'concurrent-password-one', 'operator'),
    auth.createUser('concurrent', 'concurrent-password-two', 'viewer'),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(auth.listUsers().length, 1);
  const store = JSON.parse(await readFile(path.join(directory, 'panel-users.json'), 'utf8')) as { users: unknown[] };
  assert.equal(store.users.length, 1);
});
