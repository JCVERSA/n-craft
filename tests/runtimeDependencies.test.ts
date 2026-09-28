import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  BedrockRuntimeDependencies,
  getOpenSsl11LibraryDirectory,
  parseUbuntuFocalLibsslRecord,
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
