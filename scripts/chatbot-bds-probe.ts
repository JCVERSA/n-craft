import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { runChatbotBdsProtocolProbe, resolveProtocolProbeTarget, type ProbeClient } from '../src/bedrock/chatbot/protocolProbe.ts';
import type { VersionEntry } from '../src/types/backend.ts';

const require = createRequire(import.meta.url);
const usage = `Usage : npm run chatbot:probe -- --version <version-BDS> [--port <port>]\n\nExemple : npm run chatbot:probe -- --version 1.19.50.02 --port 29132\nLe script se connecte uniquement à 127.0.0.1 et ne démarre pas le serveur.`;

function parseArguments(arguments_: string[]): { version: string; port: number } | { help: true } {
  let version = '';
  let port = 19_132;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    if (argument === '--version') {
      version = arguments_[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (argument === '--port') {
      const value = Number(arguments_[index + 1]);
      if (!Number.isSafeInteger(value)) throw new Error('--port doit être suivi d’un entier.');
      port = value;
      index += 1;
      continue;
    }
    throw new Error(`Option inconnue : ${argument}`);
  }
  if (!version) throw new Error('Indique la version exacte avec --version.');
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    throw new Error('--port doit être compris entre 1024 et 65535.');
  }
  return { version, port };
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if ('help' in args) {
    console.log(usage);
    return;
  }

  const catalogPath = path.resolve(process.cwd(), 'data', 'versions.json');
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as { versions: VersionEntry[] };
  const entry = catalog.versions.find((version) => version.version === args.version && version.channel === 'stable');
  if (!entry) throw new Error(`La version BDS stable ${args.version} n’existe pas dans le catalogue N-Craft.`);

  const target = resolveProtocolProbeTarget(entry);
  if (!target.supported || !target.clientVersion || target.protocolVersion === null) {
    throw new Error(target.reason);
  }

  console.log(`Version BDS à tester : ${entry.version}`);
  console.log(`Client de test : ${target.clientVersion} · protocole ${target.protocolVersion}${target.usesAlias ? ' (alias de protocole)' : ''}`);
  console.log(`Adresse : 127.0.0.1:${args.port} (le script refuse les connexions distantes)`);
  console.log('Le test envoie un message ordinaire et aléatoire entre deux clients hors ligne; il ne commence pas par « .. ».');
  console.log('Aucun compte Microsoft, aucune clé IA, aucun monde et aucun fichier de configuration N-Craft ne sont utilisés.');
  console.warn('À utiliser uniquement avec une copie BDS temporaire et vide, en mode hors ligne, sans port public, tunnel ni transfert UDP.');
  console.warn('N’utilise jamais ce test sur le serveur actif ou un monde réel. Vérifie aussi que tu as accepté l’EULA officielle.');

  const terminal = readline.createInterface({ input: stdin, output: stdout });
  let confirmation = '';
  try {
    confirmation = await terminal.question('Si ces conditions sont réunies, tape TEST-BDS pour continuer : ');
  } finally {
    terminal.close();
  }
  if (confirmation.trim() !== 'TEST-BDS') throw new Error('Test annulé; aucune connexion n’a été tentée.');

  const { Client } = require('bedrock-protocol/src/client.js') as {
    Client: new(options: Record<string, unknown>) => ProbeClient;
  };
  const result = await runChatbotBdsProtocolProbe({
    entry,
    port: args.port,
    clientFactory: (clientOptions) => new Client(clientOptions),
  });
  console.log(`PASS — le BDS ${result.build} a relayé le message entre deux clients de test (protocole ${result.protocolVersion}).`);
  console.log('Cela valide ce test local uniquement; l’authentification Microsoft et les fournisseurs IA ne sont pas testés.');
}

main().catch((error: unknown) => {
  console.error(`ÉCHEC — ${(error as Error).message || 'erreur inconnue'}`);
  process.exitCode = 1;
});
