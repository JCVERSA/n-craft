import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as openpgp from 'openpgp';
import {
  BedrockRuntimeDependencies,
  getOpenSsl11LibraryDirectory,
  parseUbuntuFocalLibsslRecord,
  verifyUbuntuInRelease,
  type BinaryDependencyReport,
} from '../src/bedrock/runtimeDependencies.ts';

function report(overrides: Partial<BinaryDependencyReport> = {}): BinaryDependencyReport {
  return {
    isElf: true,
    missingLibraries: [],
    compatibilityIssues: [],
    output: 'all shared libraries resolved',
    ...overrides,
  };
}

test('checks an ELF without downloading or exposing an uninstalled OpenSSL directory', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'ncraft-runtime-clean-'));
  try {
    let installCalls = 0;
    let inspectedPath = '';
    const runtime = new BedrockRuntimeDependencies(dataDirectory, {
      inspectBinary: async (_binaryPath, librarySearchPath) => {
        inspectedPath = librarySearchPath;
        return report();
      },
      installOpenSsl11: async () => { installCalls += 1; },
    });

    await runtime.ensureForBinary('/tmp/staging/bedrock_server', '/tmp/staging');

    assert.equal(installCalls, 0);
    assert.equal(inspectedPath.includes(getOpenSsl11LibraryDirectory(dataDirectory)), false);
    assert.equal(inspectedPath.includes('/tmp/staging'), false);
    assert.deepEqual(runtime.libraryDirectories(), []);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('uses ldd to inspect a real ELF on Linux without modifying system libraries', async (context) => {
  if (process.platform !== 'linux') {
    context.skip('The runtime dependency inspector invokes Linux ldd.');
    return;
  }
  const runtime = new BedrockRuntimeDependencies('/tmp/ncraft-runtime-test-data');
  await runtime.ensureForBinary('/bin/true', '/bin');
});

test('installs local OpenSSL only for the two legacy SONAMEs and rechecks the binary', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'ncraft-runtime-legacy-'));
  try {
    let installCalls = 0;
    let inspectionCalls = 0;
    const inspectedPaths: string[] = [];
    const runtime = new BedrockRuntimeDependencies(dataDirectory, {
      inspectBinary: async (_binaryPath, librarySearchPath) => {
        inspectionCalls += 1;
        inspectedPaths.push(librarySearchPath);
        return inspectionCalls === 1
          ? report({ missingLibraries: ['libssl.so.1.1', 'libcrypto.so.1.1'] })
          : report();
      },
      installOpenSsl11: async (targetDirectory) => {
        installCalls += 1;
        const libraryDirectory = getOpenSsl11LibraryDirectory(targetDirectory);
        await mkdir(libraryDirectory, { recursive: true });
        await writeFile(path.join(libraryDirectory, 'libssl.so.1.1'), Buffer.alloc(16 * 1024));
        await writeFile(path.join(libraryDirectory, 'libcrypto.so.1.1'), Buffer.alloc(16 * 1024));
      },
    });

    await runtime.ensureForBinary('/tmp/staging/bedrock_server', '/tmp/staging');

    assert.equal(installCalls, 1);
    assert.equal(inspectionCalls, 2);
    assert.equal(inspectedPaths[0]?.includes(getOpenSsl11LibraryDirectory(dataDirectory)), false);
    assert.equal(inspectedPaths[1]?.split(path.delimiter)[0], getOpenSsl11LibraryDirectory(dataDirectory));
    assert.deepEqual(runtime.libraryDirectories(), [getOpenSsl11LibraryDirectory(dataDirectory)]);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('does not attempt an OpenSSL download to satisfy unrelated missing libraries', async () => {
  let installCalls = 0;
  const runtime = new BedrockRuntimeDependencies('/tmp/ncraft-runtime-test-data', {
    inspectBinary: async () => report({ missingLibraries: ['libcurl.so.4'] }),
    installOpenSsl11: async () => { installCalls += 1; },
  });

  await assert.rejects(
    runtime.ensureForBinary('/tmp/staging/bedrock_server', '/tmp/staging'),
    /libcurl\.so\.4/,
  );
  assert.equal(installCalls, 0);
});

test('refuses a non-ELF release before it can be launched', async () => {
  const runtime = new BedrockRuntimeDependencies('/tmp/ncraft-runtime-test-data', {
    inspectBinary: async () => report({ isElf: false }),
    installOpenSsl11: async () => assert.fail('must not download OpenSSL for a non-ELF file'),
  });

  await assert.rejects(
    runtime.ensureForBinary('/tmp/staging/bedrock_server', '/tmp/staging'),
    /ne fournit pas un binaire Bedrock ELF/,
  );
});

test('accepts only a signed focal-updates libssl1.1 amd64 package record shape', () => {
  const packages = [
    'Package: unrelated-package',
    'Version: 1.0',
    'Architecture: amd64',
    'Filename: pool/main/o/openssl/unrelated.deb',
    `SHA256: ${'1'.repeat(64)}`,
    'Size: 2000000',
    '',
    'Package: libssl1.1',
    'Version: 1.1.1f-1ubuntu2.24',
    'Architecture: amd64',
    'Filename: pool/main/o/openssl/libssl1.1_1.1.1f-1ubuntu2.24_amd64.deb',
    `SHA256: ${'a'.repeat(64)}`,
    'Size: 1234567',
    '',
  ].join('\n');
  assert.deepEqual(parseUbuntuFocalLibsslRecord(packages), {
    filename: 'pool/main/o/openssl/libssl1.1_1.1.1f-1ubuntu2.24_amd64.deb',
    sha256: 'a'.repeat(64),
    size: 1234567,
    version: '1.1.1f-1ubuntu2.24',
  });
  assert.throws(
    () => parseUbuntuFocalLibsslRecord(packages.replace('Architecture: amd64\nFilename: pool/main/o/openssl/libssl1.1_', 'Architecture: arm64\nFilename: pool/main/o/openssl/libssl1.1_')),
    /No.*libssl1\.1|Aucun paquet/,
  );
});

async function createSignedUbuntuRelease(payload: string): Promise<{
  inRelease: Buffer;
  keyring: Buffer;
  fingerprint: string;
}> {
  const keyPair = await openpgp.generateKey({
    type: 'ecc',
    curve: 'ed25519Legacy',
    userIDs: [{ name: 'N-Craft Ubuntu archive test key' }],
    format: 'object',
  });
  const message = await openpgp.createCleartextMessage({ text: payload });
  const signed = await openpgp.sign({ message, signingKeys: keyPair.privateKey });
  return {
    inRelease: Buffer.from(signed),
    keyring: Buffer.from(keyPair.publicKey.write()),
    fingerprint: keyPair.publicKey.getFingerprint().toUpperCase(),
  };
}

test('verifies a signed Ubuntu InRelease with the pinned key fingerprint without gpgv', async () => {
  const payload = [
    'Origin: Ubuntu',
    'Label: Ubuntu',
    'Suite: focal-updates',
    'Codename: focal',
    `Date: ${new Date().toUTCString()}`,
    'Architectures: amd64 arm64',
    'Components: main universe',
    'SHA256:',
    ` ${'a'.repeat(64)} 123 main/binary-amd64/Packages.gz`,
  ].join('\n');
  const signedRelease = await createSignedUbuntuRelease(payload);
  const trustedFingerprints = new Set([signedRelease.fingerprint]);

  assert.equal(
    await verifyUbuntuInRelease(signedRelease.inRelease, signedRelease.keyring, { trustedFingerprints }),
    payload,
  );
  await assert.rejects(
    verifyUbuntuInRelease(signedRelease.inRelease, signedRelease.keyring, {
      trustedFingerprints: new Set(['0'.repeat(40)]),
    }),
    /empreinte.*clé d’archive Ubuntu épinglée/,
  );

  const tamperedRelease = Buffer.from(signedRelease.inRelease.toString('utf8').replace('Codename: focal', 'Codename: jammy'));
  await assert.rejects(
    verifyUbuntuInRelease(tamperedRelease, signedRelease.keyring, { trustedFingerprints }),
    /Signature InRelease Ubuntu invalide/,
  );
});
