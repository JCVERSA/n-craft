#!/bin/sh
# One-shot/re-runnable installer for the existing Linux container or host.
# No Docker, database, .env replacement, or Bedrock-world deletion is performed.
set -eu

REPO_URL='https://github.com/JCVERSA/n-craft.git'
BRANCH='arena/01a0e06a-n-craft'
PLAYIT_VERSION='v1.0.10'
PLAYIT_DAEMON_SHA256='2df7d9f10227ab312b1ad341853db4e8a8243df5cfcdbae58713a4271711c339'
PLAYIT_CLI_SHA256='6fd54d147ae1d3232b22c1c1f4aa3d13cf16d889e840ca2d3f90b4f50a2e7301'

say() { printf '%s\n' "$*"; }
warn() { say "AVERTISSEMENT : $*" >&2; }
die() { say "ERREUR : $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage : install.sh [--dir CHEMIN] [--help]

Installe ou met à jour n-craft dans un clone Git, sans toucher au monde Bedrock.
Par défaut : réutilise le clone courant s’il s’agit de JCVERSA/n-craft, sinon
/root/n-craft (root) ou ~/n-craft (utilisateur standard).
EOF
}

INSTALL_DIR=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir)
      [ "$#" -ge 2 ] || die '--dir exige un chemin.'
      INSTALL_DIR=$2
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *) die "Option inconnue : $1 (voir --help)." ;;
  esac
done

[ "$(uname -s 2>/dev/null || true)" = Linux ] || die 'Cet installateur cible les conteneurs Linux.'
ARCH=$(uname -m 2>/dev/null || true)
case "$ARCH" in
  x86_64|amd64) ;;
  *) die "Architecture $ARCH non prise en charge par les binaires Bedrock/Playit fournis (amd64 requis)." ;;
esac

if [ -z "$INSTALL_DIR" ] && [ -n "${NCRAFT_INSTALL_DIR:-}" ]; then INSTALL_DIR=$NCRAFT_INSTALL_DIR; fi
if [ -z "$INSTALL_DIR" ]; then
  if command -v git >/dev/null 2>&1 && git rev-parse --show-toplevel >/dev/null 2>&1; then
    CURRENT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
    CURRENT_ORIGIN=$(git -C "$CURRENT_ROOT" remote get-url origin 2>/dev/null || true)
    case "$CURRENT_ORIGIN" in
      https://github.com/JCVERSA/n-craft.git|https://github.com/JCVERSA/n-craft|git@github.com:JCVERSA/n-craft.git)
        INSTALL_DIR=$CURRENT_ROOT
        ;;
    esac
  fi
fi
if [ -z "$INSTALL_DIR" ]; then
  if [ "$(id -u)" -eq 0 ]; then INSTALL_DIR=/root/n-craft; else INSTALL_DIR=$HOME/n-craft; fi
fi
case "$INSTALL_DIR" in
  /*) ;;
  *) INSTALL_DIR=$(pwd)/$INSTALL_DIR ;;
esac

if [ "$(id -u)" -eq 0 ]; then BIN_DIR=/usr/local/bin; else BIN_DIR=$HOME/.local/bin; fi

APT_AVAILABLE=0
if [ "$(id -u)" -eq 0 ] && command -v apt-get >/dev/null 2>&1; then APT_AVAILABLE=1; fi
apt_install() {
  [ "$APT_AVAILABLE" -eq 1 ] || return 1
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"
}

if ! command -v curl >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1; then
  [ "$APT_AVAILABLE" -eq 1 ] || die 'curl et git sont requis ; installe-les avec ton gestionnaire de paquets puis relance.'
  apt-get update
  apt_install ca-certificates curl git
fi
command -v sha256sum >/dev/null 2>&1 || {
  if [ "$APT_AVAILABLE" -eq 1 ]; then apt-get update; apt_install coreutils; else die 'sha256sum requis pour vérifier les binaires Playit.'; fi
}

node_supported() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit((a===20&&b>=19)||(a===22&&b>=12)||a>22?0:1)' >/dev/null 2>&1
}
if ! node_supported; then
  if [ "$APT_AVAILABLE" -eq 1 ]; then
    say 'Installation de Node.js 22 LTS (NodeSource)…'
    apt-get update
    NODE_SETUP=$(mktemp)
    trap 'rm -f "$NODE_SETUP"' EXIT HUP INT TERM
    curl -fsSL https://deb.nodesource.com/setup_22.x -o "$NODE_SETUP"
    bash "$NODE_SETUP"
    rm -f "$NODE_SETUP"
    trap - EXIT HUP INT TERM
    apt_install nodejs
  else
    die 'Node.js 20.19+ ou 22.12+ est requis. Sur un conteneur non-root, installe Node 22 LTS puis relance.'
  fi
fi
node_supported || die "Node.js $(node -v 2>/dev/null || echo inconnu) n’est pas assez récent."
command -v npm >/dev/null 2>&1 || die 'npm est introuvable après la vérification de Node.js.'

if command -v ldconfig >/dev/null 2>&1 && ! ldconfig -p 2>/dev/null | grep -q 'libcurl\.so\.4'; then
  if [ "$APT_AVAILABLE" -eq 1 ]; then
    apt-get update
    apt_install libcurl4
  else
    warn 'libcurl.so.4 absent ; le preflight indiquera si le démarrage Bedrock/Playit est impossible.'
  fi
fi

MEMORY_LIMIT=''
if [ -r /sys/fs/cgroup/memory.max ]; then
  MEMORY_LIMIT=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || true)
  [ "$MEMORY_LIMIT" = max ] && MEMORY_LIMIT=''
elif [ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
  MEMORY_LIMIT=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || true)
fi
case "$MEMORY_LIMIT" in
  ''|*[!0-9]*) ;;
  *)
    if [ "$MEMORY_LIMIT" -lt 4294967296 ]; then
      MEMORY_MIB=$((MEMORY_LIMIT / 1048576))
      warn "Limite mémoire : ${MEMORY_MIB} Mio (< 4 Gio). L’installation continue, mais npm/Bedrock peuvent manquer de mémoire."
    fi
    ;;
esac

say "Répertoire d’installation : $INSTALL_DIR"
if [ -d "$INSTALL_DIR/.git" ]; then
  ORIGIN=$(git -C "$INSTALL_DIR" remote get-url origin 2>/dev/null || true)
  case "$ORIGIN" in
    https://github.com/JCVERSA/n-craft.git|https://github.com/JCVERSA/n-craft|git@github.com:JCVERSA/n-craft.git) ;;
    *) die "Le dépôt existant dans $INSTALL_DIR ne correspond pas à $REPO_URL ; aucun fichier n’a été modifié." ;;
  esac
  DIRTY=$(git -C "$INSTALL_DIR" status --porcelain --untracked-files=normal)
  [ -z "$DIRTY" ] || die "Le clone existant contient des changements locaux ; préserve-les ou nettoie-les manuellement avant l’installation."
  say 'Mise à jour fast-forward du clone existant…'
  git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
elif [ -d "$INSTALL_DIR" ]; then
  if [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null || true)" ]; then
    die "$INSTALL_DIR existe et n’est pas un clone Git de n-craft ; aucun fichier n’a été remplacé. Choisis --dir."
  fi
  rmdir "$INSTALL_DIR"
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR"
else
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

[ -f "$INSTALL_DIR/package.json" ] || die 'Le clone ne contient pas package.json.'
[ -f "$INSTALL_DIR/manage.sh" ] || die 'Le clone ne contient pas manage.sh.'
chmod 755 "$INSTALL_DIR/manage.sh" "$INSTALL_DIR/scripts/install.sh" "$INSTALL_DIR/scripts/env-manager.mjs"
mkdir -p "$BIN_DIR"

if [ -e "$BIN_DIR/ncraft" ] && [ ! -L "$BIN_DIR/ncraft" ]; then
  die "$BIN_DIR/ncraft existe et n’est pas un lien de n-craft ; aucun fichier n’a été écrasé."
fi
if [ -L "$BIN_DIR/ncraft" ]; then
  OLD_TARGET=$(readlink -f "$BIN_DIR/ncraft" 2>/dev/null || true)
  NEW_TARGET=$(readlink -f "$INSTALL_DIR/manage.sh" 2>/dev/null || true)
  [ -n "$OLD_TARGET" ] && [ "$OLD_TARGET" = "$NEW_TARGET" ] || die "$BIN_DIR/ncraft pointe vers un autre gestionnaire ; enlève le conflit manuellement avant de continuer."
fi
ln -sfn "$INSTALL_DIR/manage.sh" "$BIN_DIR/ncraft"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) PATH="$BIN_DIR:$PATH"; export PATH ;;
esac
if [ "$(id -u)" -ne 0 ]; then
  for PROFILE in "$HOME/.profile" "$HOME/.bashrc"; do
    [ -f "$PROFILE" ] || : > "$PROFILE"
    if ! grep -F "$BIN_DIR" "$PROFILE" >/dev/null 2>&1; then
      printf '\n# n-craft command-line manager\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$PROFILE"
    fi
  done
fi

install_playit_binary() {
  COMMAND_NAME=$1
  ASSET_NAME=$2
  EXPECTED_SHA=$3
  EXISTING=$(command -v "$COMMAND_NAME" 2>/dev/null || true)
  if [ -n "$EXISTING" ] && [ -f "$EXISTING" ]; then
    EXISTING_SHA=$(sha256sum "$EXISTING" 2>/dev/null | awk '{print $1}' || true)
    if [ "$EXISTING_SHA" = "$EXPECTED_SHA" ]; then
      say "$COMMAND_NAME déjà présent et SHA-256 v1.0.10 vérifié ($EXISTING)."
      return 0
    fi
    if [ "$EXISTING" = "$BIN_DIR/$COMMAND_NAME" ]; then
      warn "$EXISTING n’est pas le binaire Playit épinglé ; il est conservé sans remplacement. Vérifie sa compatibilité IPC v2 ou configure un binaire v1.x."
      return 0
    fi
    say "$COMMAND_NAME existe en $EXISTING mais n’est pas la version épinglée ; installation d’un binaire vérifié dans $BIN_DIR (l’existant reste intact)."
  fi
  TARGET="$BIN_DIR/$COMMAND_NAME"
  if [ -e "$TARGET" ]; then
    warn "$TARGET existe déjà et ne correspond pas au binaire épinglé ; il est conservé sans remplacement. Vérifie sa compatibilité IPC v2."
    return 0
  fi
  TEMP=$(mktemp)
  trap 'rm -f "$TEMP"' EXIT HUP INT TERM
  URL="https://github.com/playit-cloud/playit-agent/releases/download/$PLAYIT_VERSION/$ASSET_NAME"
  say "Téléchargement vérifié de $COMMAND_NAME ($PLAYIT_VERSION)…"
  if ! curl -fL --retry 2 --connect-timeout 15 "$URL" -o "$TEMP"; then
    rm -f "$TEMP"
    trap - EXIT HUP INT TERM
    warn "$COMMAND_NAME n’a pas pu être téléchargé ; l’application restera installée, mais le tunnel Playit ne sera pas disponible."
    return 0
  fi
  ACTUAL_SHA=$(sha256sum "$TEMP" | awk '{print $1}')
  if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
    rm -f "$TEMP"
    trap - EXIT HUP INT TERM
    die "SHA-256 invalide pour $ASSET_NAME ; binaire rejeté."
  fi
  chmod 755 "$TEMP"
  mv "$TEMP" "$TARGET"
  trap - EXIT HUP INT TERM
  say "$COMMAND_NAME installé dans $TARGET (SHA-256 vérifié)."
}

# Official, pinned Playit Agent release with SHA-256 hashes obtained from its GitHub release metadata.
install_playit_binary playitd playit-linux-amd64 "$PLAYIT_DAEMON_SHA256"
install_playit_binary playit playit-cli-linux-amd64 "$PLAYIT_CLI_SHA256"

ENV_EXISTED=0
[ -e "$INSTALL_DIR/.env" ] && ENV_EXISTED=1
say 'Préparation de .env et build du panneau…'
if ! bash "$INSTALL_DIR/manage.sh" setup --no-prompt; then
  die 'Le setup a échoué. .env et les données Bedrock existantes ont été préservés ; corrige le diagnostic puis relance.'
fi

say ''
say 'Installation terminée.'
say "  Gestionnaire : $BIN_DIR/ncraft"
say '  Démarrer le dashboard : ncraft start'
ACTIVE_TUNNEL_PROVIDER=$(node "$INSTALL_DIR/scripts/env-manager.mjs" get TUNNEL_PROVIDER 2>/dev/null | tr '[:upper:]' '[:lower:]' || true)
if [ "$ACTIVE_TUNNEL_PROVIDER" = playit ]; then
  say '  Playit sélectionné : ouvre le dashboard, approuve le lien de claim et configure manuellement un tunnel UDP local 19132.'
else
  say '  Localtonet par défaut : installe/vérifie le client headless, configure LOCALTONET_AUTH_TOKEN et LOCALTONET_API_KEY via ncraft env, puis crée manuellement le tunnel UDP local 19132 dans Localtonet.'
fi
say '  Bedrock ne démarre pas automatiquement : utilise Start dans le dashboard.'
say '  Le jeton de connexion reste privé ; pour l’afficher localement : ncraft env get PANEL_TOKEN --reveal'
if [ "$ENV_EXISTED" -eq 1 ]; then
  say '  .env existant conservé ; aucun secret ni réglage n’a été remplacé.'
else
  say '  Un .env avec PANEL_TOKEN aléatoire (permissions 0600) a été créé.'
fi
if [ "$(id -u)" -ne 0 ]; then
  say '  Si `ncraft` est introuvable dans un shell déjà ouvert, reconnecte-toi ou exécute : . ~/.profile'
fi

if [ -r /dev/tty ] && [ -w /dev/tty ]; then
  printf '\nOuvrir maintenant le menu interactif `ncraft env` ? [y/N] ' > /dev/tty
  ANSWER=''
  IFS= read -r ANSWER < /dev/tty || ANSWER=''
  case "$ANSWER" in
    y|Y|yes|YES) "$BIN_DIR/ncraft" env ;;
    *) ;;
  esac
fi
