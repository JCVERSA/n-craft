import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response } from 'express';
import { PanelAuthService } from '../src/auth.ts';
import { isSameOriginRequest, parseProxyTrust, requireHttpsInProduction } from '../src/security.ts';

const validToken = 'a-long-random-panel-token-for-tests-2026';

test('rejects the shipped PANEL_TOKEN placeholder and compares a configured token', () => {
  assert.throws(() => new PanelAuthService('replace-with-a-long-random-token'), /placeholder/);
  const auth = new PanelAuthService(validToken);
  assert.equal(auth.configured, true);
  assert.equal(auth.verifyPanelToken(validToken), true);
  assert.equal(auth.verifyPanelToken('wrong-token'), false);
});

test('proxy trust is opt-in, explicit, and does not accept wildcard trust', () => {
  const previousTrust = process.env.PANEL_TRUST_PROXY;
  try {
    delete process.env.PANEL_TRUST_PROXY;
    assert.equal(parseProxyTrust(undefined), false);
    assert.equal(parseProxyTrust('0'), 0);
    assert.equal(parseProxyTrust('1'), 1);
    assert.deepEqual(parseProxyTrust('10.0.0.0/8, 192.168.1.4'), ['10.0.0.0/8', '192.168.1.4']);
    assert.throws(() => parseProxyTrust('true'), /ne peut pas faire confiance à tous/);
    assert.throws(() => parseProxyTrust('*'), /ne peut pas faire confiance à tous/);
    assert.throws(() => parseProxyTrust('999999999999999999999999999999'), /nombre sûr de hops/);
  } finally {
    if (previousTrust === undefined) delete process.env.PANEL_TRUST_PROXY;
    else process.env.PANEL_TRUST_PROXY = previousTrust;
  }
});

test('same-origin checks ignore forwarded headers unless proxy trust is configured', () => {
  const previousOrigin = process.env.PANEL_ORIGIN;
  const previousTrust = process.env.PANEL_TRUST_PROXY;
  try {
    delete process.env.PANEL_ORIGIN;
    process.env.PANEL_TRUST_PROXY = '0';
    const rawRequest = {
      headers: {
        host: 'internal.local',
        origin: 'https://public.example',
        'x-forwarded-host': 'public.example',
        'x-forwarded-proto': 'https',
      },
      socket: { encrypted: false },
    };
    assert.equal(isSameOriginRequest(rawRequest), false);

    process.env.PANEL_TRUST_PROXY = '1';
    assert.equal(isSameOriginRequest(rawRequest), true);
    assert.equal(isSameOriginRequest({
      ...rawRequest,
      headers: { ...rawRequest.headers, origin: 'null', referer: 'https://public.example/path' },
    }), false);
  } finally {
    if (previousOrigin === undefined) delete process.env.PANEL_ORIGIN;
    else process.env.PANEL_ORIGIN = previousOrigin;
    if (previousTrust === undefined) delete process.env.PANEL_TRUST_PROXY;
    else process.env.PANEL_TRUST_PROXY = previousTrust;
  }
});

test('bounds in-memory sessions by evicting the oldest active session', () => {
  const auth = new PanelAuthService(validToken);
  let firstCookie = '';
  let latestCookie = '';
  const response = {
    setHeader: (_name: string, value: string) => { latestCookie = value; },
  } as unknown as Response;
  const request = { secure: false } as Request;
  for (let index = 0; index < 4097; index += 1) {
    auth.createSession(response, request);
    if (index === 0) firstCookie = latestCookie.split(';', 1)[0] ?? '';
  }
  assert.equal(auth.isAuthenticated({ headers: { cookie: firstCookie } } as Request), false);
  assert.equal(auth.isAuthenticated({ headers: { cookie: latestCookie.split(';', 1)[0] } } as Request), true);
});

test('production rejects plain HTTP but accepts a request recognized as HTTPS', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    let status = 0;
    let body = '';
    let nextCalled = false;
    const response = {
      status(code: number) { status = code; return this; },
      type() { return this; },
      send(value: string) { body = value; return this; },
    } as unknown as Response;
    requireHttpsInProduction({ secure: false } as Request, response, () => { nextCalled = true; });
    assert.equal(status, 400);
    assert.match(body, /HTTPS requis/);
    assert.equal(nextCalled, false);

    requireHttpsInProduction({ secure: true } as Request, response, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test('production session cookies are Secure even when created behind HTTP internally', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const auth = new PanelAuthService(validToken);
    let cookie = '';
    const response = {
      setHeader: (_name: string, value: string) => { cookie = value; },
    } as unknown as Response;
    const request = {
      secure: false,
      headers: {},
      get: () => undefined,
    } as unknown as Request;
    auth.createSession(response, request);
    assert.match(cookie, /; Secure$/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});
