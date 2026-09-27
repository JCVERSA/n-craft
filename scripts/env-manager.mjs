#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(appDirectory, '.env');
const examplePath = path.join(appDirectory, '.env.example');
const known = [
  ['PANEL_TOKEN', 'Jeton privé de connexion au dashboard.'],
  ['PORT', 'Port HTTP du panneau dans le conteneur.'],
  ['TUNNEL_PROVIDER', 'Fournisseur de tunnel : localtonet (par défaut) ou playit.'],
  ['LOCALTONET_BIN', 'Chemin ou nom du client Localtonet headless.'],
  ['LOCALTONET_AUTH_TOKEN', 'AuthToken du client Localtonet (secret, masqué).'],
  ['LOCALTONET_API_KEY', 'Clé API Localtonet pour détecter le tunnel (secret, masqué).'],
  ['LOCALTONET_API_POLL_INTERVAL_MS', 'Intervalle de détection de l’adresse Localtonet.'],
  ['LOCALTONET_API_TIMEOUT_MS', 'Délai maximal des requêtes API Localtonet.'],
  ['PLAYIT_BIN', 'Chemin ou nom du daemon officiel playitd.'],
  ['PLAYIT_CLI_BIN', 'Chemin ou nom du CLI officiel Playit (claim).'],
  ['PLAYIT_SECRET_PATH', 'Chemin facultatif du fichier secret Playit ; jamais la clé elle-même.'],
  ['DATA_DIR', 'Dossier persistant pour l’état, les logs et les données du panneau.'],
  ['BEDROCK_SERVER_DIR', 'Dossier persistant Bedrock ; Deploy le met à jour sans effacer les données.'],
  ['PANEL_ORIGIN', 'Origine HTTPS publique exacte si elle ne peut pas être déduite.'],
  ['PANEL_TRUST_PROXY', 'Nombre de proxies de confiance ou liste d’IP/CIDR.'],
  ['BDS_START_TIMEOUT_MS', 'Délai maximal de démarrage Bedrock en millisecondes.'],
  ['BDS_STOP_TIMEOUT_MS', 'Délai maximal d’arrêt Bedrock en millisecondes.'],
  ['BDS_RESTART_ENABLED', 'Active le redémarrage quotidien planifié de Bedrock.'],
  ['BDS_RESTART_TIME', 'Heure locale du redémarrage quotidien (HH:MM).'],
  ['BDS_RESTART_TIMEZONE', 'Fuseau IANA du redémarrage quotidien (Africa/Douala par défaut).'],
  ['BDS_RESTART_WARNING_MINUTES', 'Durée du compte à rebours annoncé en jeu avant redémarrage.'],
  ['PLAYIT_START_TIMEOUT_MS', 'Délai de connexion IPC au daemon Playit.'],
  ['PLAYIT_ADDRESS_TIMEOUT_MS', 'Délai d’attente de l’adresse de tunnel.'],
  ['BDS_MAX_ZIP_BYTES', 'Taille maximale autorisée pour l’archive BDS.'],
];
const knownNames = new Set(known.map(([name]) => name));
const secretName = (name) => /(?:TOKEN|KEY|SECRET|PASSWORD)/i.test(name);

function parseEnv(content) {
  const values = new Map();
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2] ?? '';
    if (value.length >= 2 && value[0] === '"' && value.at(-1) === '"') {
      value = value.slice(1, -1)
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\\\/g, '\\')
        .replace(/\\"/g, '"');
    } else if (value.length >= 2 && value[0] === "'" && value.at(-1) === "'") {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values.set(match[1], value);
  }
  return values;
}

function encodeValue(value) {
  if (/[\r\n\0]/.test(value)) throw new Error('Les valeurs .env ne peuvent pas contenir de saut de ligne ni de NUL.');
  if (/^[A-Za-z0-9_./:@+-]*$/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function replaceKey(content, key, value) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const assignment = new RegExp(`^\\s*(?:export\\s+)?${escaped}\\s*=.*$`);
  const lines = content.split(/\r?\n/);
  const output = [];
  let found = false;
  for (const line of lines) {
    if (!assignment.test(line)) {
      output.push(line);
      continue;
    }
    if (found) continue;
    output.push(`${key}=${encodeValue(value)}`);
    found = true;
  }
  if (!found) {
    while (output.length && output.at(-1) === '') output.pop();
    output.push(`${key}=${encodeValue(value)}`);
  }
  return `${output.join('\n').replace(/\n*$/, '')}\n`;
}

async function storagePath() {
  try {
    const entry = await lstat(envPath);
    if (entry.isSymbolicLink()) {
      throw new Error('.env est un lien symbolique ; modifie sa cible manuellement pour éviter tout écrasement involontaire.');
    }
    return envPath;
  } catch (error) {
    if (error.code === 'ENOENT') return envPath;
    throw error;
  }
}

async function ensurePrivatePermissions() {
  const entry = await lstat(envPath);
  const target = await stat(envPath);
  if ((target.mode & 0o077) === 0) return;
  if (entry.isSymbolicLink()) {
    console.warn('Avertissement : .env est un lien symbolique ; les permissions de sa cible ne sont pas modifiées automatiquement.');
    return;
  }
  await chmod(envPath, 0o600);
}

async function atomicWrite(content) {
  const target = await storagePath();
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${randomBytes(5).toString('hex')}`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
    await chmod(target, 0o600);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readCurrent() {
  try {
    return await readFile(envPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

async function setValue(key, value) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error('Nom de variable invalide. Utilise A-Z, 0-9 et _ uniquement.');
  if (key === 'PLAYIT_SECRET_KEY') {
    throw new Error('PLAYIT_SECRET_KEY n’est plus demandé : configure Playit depuis le dashboard. Utilise `ncraft env unset PLAYIT_SECRET_KEY` pour retirer une ancienne valeur.');
  }
  if (key === 'PANEL_TOKEN' && (value.length < 32 || value === 'replace-with-a-long-random-token')) {
    throw new Error('PANEL_TOKEN doit contenir au moins 32 caractères aléatoires.');
  }
  const current = await readCurrent();
  await atomicWrite(replaceKey(current, key, value));
}

async function unsetValue(key) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error('Nom de variable invalide.');
  const current = await readCurrent();
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const assignment = new RegExp(`^\\s*(?:export\\s+)?${escaped}\\s*=.*$`);
  const next = current.split(/\r?\n/).filter((line) => !assignment.test(line)).join('\n').replace(/\n*$/, '\n');
  await atomicWrite(next);
}

function masked(value) {
  if (!value) return '(non défini)';
  if (value.length <= 6) return '••••••';
  return `${value.slice(0, 3)}…${value.slice(-2)} (${value.length} caractères)`;
}

async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (command === 'init') {
    let current;
    let existed = true;
    try {
      current = await readFile(envPath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      existed = false;
      current = await readFile(examplePath, 'utf8');
    }
    const values = parseEnv(current);
    const token = values.get('PANEL_TOKEN');
    if (token && token !== 'replace-with-a-long-random-token') {
      await ensurePrivatePermissions();
      console.log(existed ? '.env existant conservé sans réécriture ; valeurs préservées.' : '.env initialisé avec les valeurs de .env.example.');
    } else {
      current = replaceKey(current, 'PANEL_TOKEN', randomBytes(32).toString('hex'));
      await atomicWrite(current);
      console.log(existed ? '.env existant complété avec un PANEL_TOKEN aléatoire ; les autres valeurs sont préservées.' : '.env créé avec un PANEL_TOKEN aléatoire (0600).');
    }
    console.log('Pour afficher le jeton sur cette machine : ncraft env get PANEL_TOKEN --reveal');
    return;
  }
  if (command === 'set') {
    if (args.length < 2) throw new Error('Usage : ncraft env set CLE VALEUR');
    const [key, ...valueParts] = args;
    await setValue(key, valueParts.join(' '));
    console.log(`${key} mis à jour dans .env (permissions 0600).`);
    return;
  }
  if (command === 'set-stdin') {
    const key = args[0];
    if (!key || args.length !== 1) throw new Error('Usage interne : ncraft env set-stdin CLE < valeur');
    let value = '';
    for await (const chunk of process.stdin) value += chunk.toString();
    await setValue(key, value);
    console.log(`${key} mis à jour dans .env (permissions 0600).`);
    return;
  }
  if (command === 'unset') {
    const key = args[0];
    if (!key) throw new Error('Usage : ncraft env unset CLE');
    await unsetValue(key);
    console.log(`${key} supprimée de .env.`);
    return;
  }
  if (command === 'get') {
    const key = args[0];
    if (!key) throw new Error('Usage : ncraft env get CLE [--reveal]');
    const values = parseEnv(await readCurrent());
    const value = values.get(key) ?? '';
    console.log(secretName(key) && !args.includes('--reveal') ? masked(value) : value);
    return;
  }
  if (command === 'list') {
    const values = parseEnv(await readCurrent());
    const printed = new Set();
    for (const [key, description] of known) {
      const value = values.get(key) ?? '';
      console.log(`${key}=${secretName(key) ? masked(value) : (value || '(non défini)')}`);
      console.log(`  ${description}`);
      printed.add(key);
    }
    for (const [key, value] of values) {
      if (printed.has(key)) continue;
      console.log(`${key}=${secretName(key) ? masked(value) : (value || '(vide)')}  (clé avancée)`);
    }
    return;
  }
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log('Usage : ncraft env [list | get CLE [--reveal] | set CLE VALEUR | unset CLE | edit]');
    console.log('Sans sous-commande, ouvre le menu interactif. Les secrets sont masqués par défaut.');
    return;
  }
  throw new Error(`Sous-commande env inconnue : ${command}`);
}

main().catch((error) => {
  console.error(`Erreur .env : ${error.message}`);
  process.exitCode = 1;
});
