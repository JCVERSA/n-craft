#!/usr/bin/env bash
# Nebula Craft — install/runtime manager for the existing Bedrock container.
set -uo pipefail

SELF="${BASH_SOURCE[0]}"
while [[ -L "$SELF" ]]; do
  SELF_DIR="$(cd -P "$(dirname "$SELF")" >/dev/null 2>&1 && pwd)"
  TARGET="$(readlink "$SELF")"
  if [[ "$TARGET" = /* ]]; then SELF="$TARGET"; else SELF="$SELF_DIR/$TARGET"; fi
done
APP_DIR="$(cd -P "$(dirname "$SELF")" >/dev/null 2>&1 && pwd)"
ENV_FILE="$APP_DIR/.env"
ENV_HELPER="$APP_DIR/scripts/env-manager.mjs"
UPDATE_BRANCH='arena/01a0e06a-n-craft'
PID_FILE=""
LOG_FILE=""
PANEL_PID=""
PORT="${PORT:-}"
DATA_DIR=""

if [[ -t 1 ]]; then
  C_GREEN=$'\033[1;32m'; C_RED=$'\033[1;31m'; C_YELLOW=$'\033[1;33m'; C_CYAN=$'\033[1;36m'; C_RESET=$'\033[0m'
else
  C_GREEN=""; C_RED=""; C_YELLOW=""; C_CYAN=""; C_RESET=""
fi
ok() { printf '%sOK%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s⚠%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
info() { printf '%sINFO%s %s\n' "$C_CYAN" "$C_RESET" "$*"; }
fail() { printf '%sERREUR:%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; return 1; }
step() { printf '\n%s==> %s%s\n' "$C_CYAN" "$*" "$C_RESET"; }

read_env() {
  [[ -f "$ENV_FILE" && -f "$ENV_HELPER" ]] || return 0
  node "$ENV_HELPER" get "$1" --reveal 2>/dev/null || true
}

is_executable_setting() {
  local setting="$1"
  [[ -n "$setting" ]] || return 1
  if [[ "$setting" == */* ]]; then
    if [[ "$setting" == /* ]]; then [[ -x "$setting" ]]; else [[ -x "$APP_DIR/$setting" ]]; fi
  else
    command -v "$setting" >/dev/null 2>&1
  fi
}

raw_data_dir="${DATA_DIR:-$(read_env DATA_DIR)}"
if [[ -z "$raw_data_dir" ]]; then raw_data_dir=data; fi
if [[ "$raw_data_dir" = /* ]]; then DATA_DIR="$raw_data_dir"; else DATA_DIR="$APP_DIR/$raw_data_dir"; fi
PID_FILE="$DATA_DIR/panel.pid"
LOG_FILE="$DATA_DIR/panel.log"
raw_port="${PORT:-$(read_env PORT)}"
if [[ -n "$raw_port" ]]; then PORT="$raw_port"; else PORT=3000; fi

require_repo() {
  [[ -d "$APP_DIR/.git" ]] || { fail "Le gestionnaire doit être exécuté depuis un clone Git de n-craft ($APP_DIR)."; return 1; }
  [[ -f "$APP_DIR/package.json" && -f "$ENV_HELPER" ]] || { fail "Fichiers de l’application ou du gestionnaire .env manquants."; return 1; }
  command -v node >/dev/null 2>&1 || { fail "Node.js est introuvable."; return 1; }
}

read_memory_limit_mb() {
  local value=""
  if [[ -r /sys/fs/cgroup/memory.max ]]; then
    value="$(cat /sys/fs/cgroup/memory.max 2>/dev/null)"
    [[ "$value" == max ]] && value=""
  elif [[ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ]]; then
    value="$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null)"
  fi
  if [[ "$value" =~ ^[0-9]+$ ]] && (( value > 0 && value < 1152921504606846976 )); then
    echo $((value / 1048576))
  fi
}

panel_pid_is_running() {
  local pid="$1" cwd="" cmd=""
  [[ "$pid" =~ ^[0-9]+$ && -r "/proc/$pid/cmdline" ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
  [[ "$cwd" == "$APP_DIR" ]] || return 1
  cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  [[ "$cmd" == *"build/server.js"* ]]
}

get_panel_pid() {
  local pid=""
  if [[ -f "$PID_FILE" ]]; then
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if panel_pid_is_running "$pid"; then
      PANEL_PID="$pid"
      return 0
    fi
    rm -f "$PID_FILE"
  fi
  return 1
}

http_code() {
  local code=''
  code="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 4 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null || true)"
  printf '%s\n' "${code:-000}"
}

wait_for_http() {
  local seconds="$1" deadline code
  deadline=$((SECONDS + seconds))
  while (( SECONDS < deadline )); do
    code="$(http_code)"
    [[ "$code" == 200 ]] && return 0
    sleep 1
  done
  return 1
}

require_tty() {
  [[ -r /dev/tty && -w /dev/tty ]]
}

cmd_env_menu() {
  require_repo || return 1
  require_tty || { fail 'Le menu env interactif exige un terminal. Utilise ncraft env set/list/get/unset/edit.'; return 1; }
  node "$ENV_HELPER" init >/dev/null || return 1
  local choice key description value masked index
  local -a keys descriptions
  keys=(PANEL_TOKEN PORT TUNNEL_PROVIDER LOCALTONET_BIN LOCALTONET_AUTH_TOKEN LOCALTONET_API_KEY LOCALTONET_API_POLL_INTERVAL_MS LOCALTONET_API_TIMEOUT_MS PLAYIT_BIN PLAYIT_CLI_BIN PLAYIT_SECRET_PATH DATA_DIR BEDROCK_SERVER_DIR PANEL_ORIGIN PANEL_TRUST_PROXY BDS_START_TIMEOUT_MS BDS_STOP_TIMEOUT_MS PLAYIT_START_TIMEOUT_MS PLAYIT_ADDRESS_TIMEOUT_MS BDS_MAX_ZIP_BYTES)
  descriptions=(
    'Jeton privé du dashboard (au moins 32 caractères).'
    'Port HTTP du panneau.'
    'Fournisseur de tunnel par défaut : localtonet ou playit.'
    'Binaire du client Localtonet headless.'
    'AuthToken du client Localtonet (secret masqué).'
    'Clé API Localtonet pour détecter l’adresse (secret masqué).'
    'Intervalle de détection de l’adresse Localtonet.'
    'Délai maximal des requêtes API Localtonet.'
    'Binaire du daemon Playit Agent 1.x.'
    'CLI Playit officiel utilisé pour le claim.'
    'Chemin facultatif du fichier secret Playit, pas la clé.'
    'Dossier persistant pour état et journaux du panneau.'
    'Dossier serveur supprimé puis recréé à chaque Deploy.'
    'Origine HTTPS publique exacte, si nécessaire.'
    'Proxies de confiance ; 0 par défaut.'
    'Délai de démarrage Bedrock en millisecondes.'
    'Délai d’arrêt Bedrock en millisecondes.'
    'Délai IPC Playit en millisecondes.'
    'Délai de détection de l’adresse Playit.'
    'Taille maximale du ZIP Bedrock en octets.'
  )
  while true; do
    printf '\n%sConfiguration .env — %s%s\n' "$C_CYAN" "$ENV_FILE" "$C_RESET"
    for i in "${!keys[@]}"; do
      key="${keys[$i]}"
      value="$(node "$ENV_HELPER" get "$key" 2>/dev/null || true)"
      printf ' %2d) %-28s %s\n     %s\n' "$((i + 1))" "$key" "${value:-'(non défini)'}" "${descriptions[$i]}"
    done
    printf '  0) Terminer\n  e) Ouvrir le fichier .env dans l’éditeur\n\n'
    printf 'Choix (0=quitter) : ' > /dev/tty
    IFS= read -r choice < /dev/tty || return 1
    [[ "$choice" == 0 ]] && break
    if [[ "$choice" == e ]]; then
      "${EDITOR:-vi}" "$ENV_FILE"
      if [[ ! -L "$ENV_FILE" ]]; then chmod 600 "$ENV_FILE" 2>/dev/null || true; fi
      continue
    fi
    if [[ ! "$choice" =~ ^[0-9]+$ ]] || (( choice < 1 || choice > ${#keys[@]} )); then
      warn 'Choix invalide.'
      continue
    fi
    index=$((choice - 1))
    key="${keys[$index]}"
    description="${descriptions[$index]}"
    printf '%s — valeur actuelle masquée si sensible. Entrée vide = conserver ; utilise `ncraft env unset %s` pour supprimer.%s\n' "$description" "$key" "$C_RESET"
    if [[ "$key" == PANEL_TOKEN || "$key" == LOCALTONET_AUTH_TOKEN || "$key" == LOCALTONET_API_KEY ]]; then
      printf 'Nouvelle valeur (saisie masquée) : ' > /dev/tty
      IFS= read -r -s value < /dev/tty || return 1
      printf '\n' > /dev/tty
    else
      printf 'Nouvelle valeur : ' > /dev/tty
      IFS= read -r value < /dev/tty || return 1
    fi
    [[ -z "$value" ]] && continue
    if [[ "$key" == PANEL_TOKEN || "$key" == LOCALTONET_AUTH_TOKEN || "$key" == LOCALTONET_API_KEY ]]; then
      printf '%s' "$value" | node "$ENV_HELPER" set-stdin "$key" || { value=""; continue; }
    else
      node "$ENV_HELPER" set "$key" "$value" || continue
    fi
    value=""
    chmod 600 "$ENV_FILE" 2>/dev/null || true
    ok "$key mis à jour."
  done
  ok 'Configuration terminée ; redémarre le panneau si sa configuration a changé.'
}

cmd_env() {
  require_repo || return 1
  local sub="${1:-menu}"
  shift || true
  case "$sub" in
    menu) cmd_env_menu ;;
    list|get|unset|help|--help|-h) node "$ENV_HELPER" "$sub" "$@" ;;
    set)
      if [[ "${1:-}" =~ ^(PANEL_TOKEN|LOCALTONET_AUTH_TOKEN|LOCALTONET_API_KEY)$ && $# -eq 1 ]]; then
        local secret_value secret_name="${1:-}"
        require_tty || { fail "Utilise un terminal pour saisir $secret_name sans l’exposer dans l’historique."; return 1; }
        printf 'Nouvelle valeur pour %s (saisie masquée) : ' "$secret_name" > /dev/tty
        IFS= read -r -s secret_value < /dev/tty || return 1
        printf '\n' > /dev/tty
        [[ -n "$secret_value" ]] || { warn 'Valeur vide : aucun changement.'; return 1; }
        printf '%s' "$secret_value" | node "$ENV_HELPER" set-stdin "$secret_name"
        secret_value=""
      else
        node "$ENV_HELPER" set "$@"
      fi
      ;;
    edit)
      node "$ENV_HELPER" init >/dev/null || return 1
      "${EDITOR:-vi}" "$ENV_FILE"
      if [[ ! -L "$ENV_FILE" ]]; then chmod 600 "$ENV_FILE" 2>/dev/null || true; fi
      ;;
    *) fail "Sous-commande env inconnue : $sub (utilise ncraft env help)." ;;
  esac
}

cmd_setup() {
  require_repo || return 1
  local no_prompt=0 env_preexisted=0 node_version memory_mb playit_daemon playit_cli localtonet_bin tunnel_provider
  for arg in "$@"; do [[ "$arg" == --no-prompt ]] && no_prompt=1; done
  [[ -f "$ENV_FILE" ]] && env_preexisted=1
  node_version="$(node -p 'process.versions.node' 2>/dev/null || true)"
  [[ -n "$node_version" ]] || { fail 'Node.js ne peut pas être exécuté.'; return 1; }
  if ! node -e 'const [a,b,c]=process.versions.node.split(".").map(Number); process.exit((a===20&&b>=19)||(a===22&&b>=12)||a>22?0:1)'; then
    fail "Node.js $node_version détecté ; n-craft exige 20.19+ ou 22.12+ (Node 22 recommandé)."
    return 1
  fi
  command -v npm >/dev/null 2>&1 || { fail 'npm est introuvable.'; return 1; }
  node "$ENV_HELPER" init || return 1
  if [[ ! -L "$ENV_FILE" ]]; then chmod 600 "$ENV_FILE" 2>/dev/null || true; fi
  memory_mb="$(read_memory_limit_mb || true)"
  if [[ -n "$memory_mb" ]] && (( memory_mb < 4096 )); then
    warn "Conteneur limité à ${memory_mb} Mio ; le build et Bedrock partagent cette mémoire. Un OOM reste possible, l’installation continue."
  fi
  step 'Installation reproductible des dépendances (npm ci)'
  (cd "$APP_DIR" && npm ci --no-audit --no-fund) || { fail 'npm ci a échoué ; aucune donnée Bedrock n’a été supprimée.'; return 1; }
  step 'Build du panneau'
  (cd "$APP_DIR" && npm run build) || { fail 'Build échoué ; aucune donnée Bedrock n’a été supprimée.'; return 1; }
  [[ -f "$APP_DIR/build/server.js" && -f "$APP_DIR/dist/index.html" ]] || { fail 'Fichiers de build attendus absents.'; return 1; }
  ok 'Dépendances et build prêts.'
  tunnel_provider="${TUNNEL_PROVIDER:-$(read_env TUNNEL_PROVIDER)}"; tunnel_provider="${tunnel_provider:-localtonet}"
  tunnel_provider="${tunnel_provider,,}"
  if [[ "$tunnel_provider" == playit ]]; then
    playit_daemon="${PLAYIT_BIN:-$(read_env PLAYIT_BIN)}"; playit_daemon="${playit_daemon:-playitd}"
    playit_cli="${PLAYIT_CLI_BIN:-$(read_env PLAYIT_CLI_BIN)}"; playit_cli="${playit_cli:-playit}"
    if ! is_executable_setting "$playit_daemon"; then warn "$playit_daemon absent ; le daemon Playit ne démarrera pas."; fi
    if ! is_executable_setting "$playit_cli"; then warn "$playit_cli absent ; le dashboard ne pourra pas générer le claim."; fi
  else
    localtonet_bin="${LOCALTONET_BIN:-$(read_env LOCALTONET_BIN)}"; localtonet_bin="${localtonet_bin:-localtonet}"
    if ! is_executable_setting "$localtonet_bin"; then warn "$localtonet_bin absent ; installe le client Localtonet Linux officiel avec support headless pour le tunnel par défaut."; fi
    [[ -n "${LOCALTONET_AUTH_TOKEN:-$(read_env LOCALTONET_AUTH_TOKEN)}" ]] || warn 'LOCALTONET_AUTH_TOKEN absent ; le client Localtonet ne pourra pas s’authentifier.'
    [[ -n "${LOCALTONET_API_KEY:-$(read_env LOCALTONET_API_KEY)}" ]] || warn 'LOCALTONET_API_KEY absente ; l’adresse publique ne pourra pas être détectée.'
  fi
  if (( env_preexisted == 0 && no_prompt == 0 )) && require_tty; then
    printf 'Ouvrir maintenant le menu ncraft env ? [Y/n] ' > /dev/tty
    local answer
    IFS= read -r answer < /dev/tty || answer='n'
    case "$answer" in n|N|no|NO) ;; *) cmd_env_menu ;; esac
  fi
}

cmd_start() {
  require_repo || return 1
  [[ -f "$APP_DIR/build/server.js" && -f "$APP_DIR/dist/index.html" ]] || { fail 'Build absent ; lance ncraft setup.'; return 1; }
  [[ -f "$ENV_FILE" ]] || { fail '.env absent ; lance ncraft setup puis ncraft env.'; return 1; }
  local token code
  token="$(read_env PANEL_TOKEN)"
  [[ ${#token} -ge 32 && "$token" != replace-with-a-long-random-token ]] || { fail 'PANEL_TOKEN absent ou trop court ; configure-le avec ncraft env.'; return 1; }
  if get_panel_pid; then
    warn "Le panneau tourne déjà (PID $PANEL_PID)."
    return 0
  fi
  code="$(http_code)"
  if [[ "$code" != 000 ]]; then
    fail "Un service répond déjà HTTP $code sur le port $PORT sans PID ncraft ; démarrage refusé pour éviter une instance concurrente."
    return 1
  fi
  mkdir -p "$DATA_DIR"
  local pid_probe="$PID_FILE.tmp-$$"
  if ! (umask 077; : > "$pid_probe"); then fail "Impossible d’écrire dans $DATA_DIR."; return 1; fi
  rm -f "$pid_probe"
  step "Démarrage du panneau sur le port $PORT"
  (
    cd "$APP_DIR" || exit 1
    export PORT NODE_ENV=production
    nohup node build/server.js >>"$LOG_FILE" 2>&1 </dev/null &
    server_pid=$!
    if ! printf '%s\n' "$server_pid" > "$PID_FILE"; then
      kill -TERM "$server_pid" 2>/dev/null || true
      wait "$server_pid" 2>/dev/null || true
      exit 1
    fi
  ) || { fail 'Impossible de créer le processus du panneau.'; return 1; }
  PANEL_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if wait_for_http 30; then
    ok "Dashboard disponible sur le port $PORT (PID $PANEL_PID). Bedrock se lance depuis le dashboard."
    return 0
  fi
  if [[ -n "$PANEL_PID" ]] && panel_pid_is_running "$PANEL_PID"; then
    warn "Le processus est lancé mais health API ne répond pas HTTP 200 ; consulte ncraft logs. Il reste actif pour éviter un arrêt forcé pendant son initialisation."
    return 1
  else
    rm -f "$PID_FILE"
    fail 'Le panneau n’a pas démarré. Dernières lignes du log :' || true
    tail -n 40 "$LOG_FILE" 2>/dev/null || true
    return 1
  fi
}

cmd_stop() {
  require_repo || return 1
  if [[ "${1:-}" == --force ]]; then
    fail 'Arrêt forcé refusé par sécurité pour éviter d’abandonner Bedrock ; inspecte les logs et le processus avant toute action manuelle.'
    return 1
  fi
  if ! get_panel_pid; then
    local code
    code="$(http_code)"
    if [[ "$code" != 000 ]]; then
      fail "Un service répond HTTP $code, mais son PID n’est pas géré par ncraft ; aucun processus n’a été arrêté."
      return 1
    fi
    info 'Le panneau est déjà arrêté.'
    return 0
  fi
  local pid="$PANEL_PID" deadline=$((SECONDS + 35))
  step "Arrêt gracieux du panneau et de ses processus enfants (PID $pid)"
  kill -TERM "$pid" 2>/dev/null || true
  while panel_pid_is_running "$pid" && (( SECONDS < deadline )); do sleep 1; done
  if panel_pid_is_running "$pid"; then
    fail 'Le panneau ne s’est pas arrêté en 35 s ; il reste actif pour éviter un arrêt forcé du monde. Vérifie ncraft logs et traite le processus manuellement.'
    return 1
  fi
  rm -f "$PID_FILE"
  ok 'Panneau arrêté ; le serveur Bedrock a reçu son arrêt gracieux.'
}

cmd_restart() {
  local was_running=0
  get_panel_pid && was_running=1
  if (( was_running )); then cmd_stop || return 1; fi
  cmd_start
}

cmd_status() {
  require_repo || return 1
  local memory_mb code
  if get_panel_pid; then
    ok "Panel actif (PID $PANEL_PID, port $PORT)."
    code="$(http_code)"
    [[ "$code" == 200 ]] && ok "Health API répond HTTP $code." || warn "Processus actif mais health API répond HTTP $code."
  else
    code="$(http_code)"
    if [[ "$code" != 000 ]]; then warn "Un service répond HTTP $code mais son PID n’est pas géré par ncraft."; else warn 'Panel arrêté.'; fi
  fi
  memory_mb="$(read_memory_limit_mb || true)"
  if [[ -n "$memory_mb" ]]; then
    printf 'Limite mémoire du conteneur : %s Mio\n' "$memory_mb"
    (( memory_mb < 4096 )) && warn 'Moins de 4 Gio : essai autorisé, mais OOM possible.'
  else
    warn 'Limite mémoire cgroup non détectée.'
  fi
  [[ -f "$ENV_FILE" ]] && node "$ENV_HELPER" list | sed -n '1,12p' || warn '.env absent.'
  [[ -f "$LOG_FILE" ]] && printf 'Log : %s\n' "$LOG_FILE"
  return 0
}

cmd_logs() {
  require_repo || return 1
  [[ -f "$LOG_FILE" ]] || { warn "Log absent : $LOG_FILE"; return 0; }
  tail -n 100 -F "$LOG_FILE"
}

cmd_doctor() {
  require_repo || return 1
  local failed=0 node_version memory_mb token playit_daemon playit_cli localtonet_bin tunnel_provider libcurl_found=0 candidate code
  node_version="$(node -p 'process.versions.node' 2>/dev/null || true)"
  if node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit((a===20&&b>=19)||(a===22&&b>=12)||a>22?0:1)' 2>/dev/null; then ok "Node.js $node_version"; else warn "Node.js $node_version ; 20.19+ ou 22.12+ requis."; failed=1; fi
  command -v npm >/dev/null 2>&1 && ok "npm $(npm -v)" || { warn 'npm absent.'; failed=1; }
  command -v git >/dev/null 2>&1 && ok "git $(git --version | awk '{print $3}')" || warn 'git absent.'
  tunnel_provider="${TUNNEL_PROVIDER:-$(read_env TUNNEL_PROVIDER)}"; tunnel_provider="${tunnel_provider:-localtonet}"
  tunnel_provider="${tunnel_provider,,}"
  if [[ "$tunnel_provider" == playit ]]; then
    playit_daemon="${PLAYIT_BIN:-$(read_env PLAYIT_BIN)}"; playit_daemon="${playit_daemon:-playitd}"
    playit_cli="${PLAYIT_CLI_BIN:-$(read_env PLAYIT_CLI_BIN)}"; playit_cli="${playit_cli:-playit}"
    if is_executable_setting "$playit_daemon"; then ok "Daemon Playit présent : $playit_daemon."; else warn "Daemon Playit absent : $playit_daemon."; fi
    if is_executable_setting "$playit_cli"; then ok "CLI Playit présent : $playit_cli."; else warn "CLI Playit absent : $playit_cli."; fi
  else
    localtonet_bin="${LOCALTONET_BIN:-$(read_env LOCALTONET_BIN)}"; localtonet_bin="${localtonet_bin:-localtonet}"
    if is_executable_setting "$localtonet_bin"; then ok "Client Localtonet présent : $localtonet_bin."; else warn "Client Localtonet absent : $localtonet_bin."; fi
    [[ -n "${LOCALTONET_AUTH_TOKEN:-$(read_env LOCALTONET_AUTH_TOKEN)}" ]] && ok 'LOCALTONET_AUTH_TOKEN configuré.' || warn 'LOCALTONET_AUTH_TOKEN absent.'
    [[ -n "${LOCALTONET_API_KEY:-$(read_env LOCALTONET_API_KEY)}" ]] && ok 'LOCALTONET_API_KEY configurée.' || warn 'LOCALTONET_API_KEY absente.'
  fi
  [[ -f "$APP_DIR/build/server.js" ]] && ok 'Build serveur présent.' || { warn 'Build absent ; lance ncraft setup.'; failed=1; }
  [[ -f "$APP_DIR/dist/index.html" ]] && ok 'Build frontend présent.' || { warn 'Build frontend absent ; lance ncraft setup.'; failed=1; }
  [[ -f "$ENV_FILE" ]] && { token="$(read_env PANEL_TOKEN)"; [[ ${#token} -ge 32 ]] && ok 'PANEL_TOKEN configuré.' || { warn 'PANEL_TOKEN absent/trop court.'; failed=1; }; } || { warn '.env absent.'; failed=1; }
  if command -v ldconfig >/dev/null 2>&1 && ldconfig -p 2>/dev/null | grep -q 'libcurl\.so\.4'; then libcurl_found=1; fi
  for candidate in /lib/x86_64-linux-gnu/libcurl.so.4 /usr/lib/x86_64-linux-gnu/libcurl.so.4 /usr/local/lib/libcurl.so.4; do
    [[ -e "$candidate" ]] && libcurl_found=1
  done
  if (( libcurl_found )); then ok 'libcurl.so.4 présente.'; else warn 'libcurl.so.4 non détectée.'; failed=1; fi
  memory_mb="$(read_memory_limit_mb || true)"
  if [[ -n "$memory_mb" ]]; then printf 'Mémoire cgroup : %s Mio\n' "$memory_mb"; (( memory_mb < 4096 )) && warn 'Sous 4 Gio : avertissement seulement ; risque d’OOM.'; else warn 'Limite cgroup inconnue.'; fi
  if get_panel_pid; then
    ok "Panel actif (PID $PANEL_PID)."
  else
    code="$(http_code)"
    if [[ "$code" != 000 ]]; then warn "Service HTTP présent mais PID non géré par ncraft (HTTP $code)."; else info 'Panel actuellement arrêté.'; fi
  fi
  (( failed == 0 ))
}

cmd_update() {
  require_repo || return 1
  local dirty was_running=0 old_rev new_rev code
  dirty="$(git -C "$APP_DIR" status --porcelain --untracked-files=normal)"
  [[ -z "$dirty" ]] || { fail 'Modifications locales détectées ; update annulé sans toucher aux fichiers.'; return 1; }
  get_panel_pid && was_running=1
  if (( was_running )); then
    cmd_stop || return 1
  else
    code="$(http_code)"
    if [[ "$code" != 000 ]]; then
      fail "Un service répond HTTP $code sans PID ncraft ; update refusé tant qu’il tourne."
      return 1
    fi
  fi
  old_rev="$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo '?')"
  step 'Mise à jour fast-forward du dépôt'
  if ! git -C "$APP_DIR" pull --ff-only origin "$UPDATE_BRANCH"; then
    warn 'Pull impossible ; tentative de redémarrage de la version existante.'
    (( was_running )) && cmd_start || true
    return 1
  fi
  new_rev="$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo '?')"
  step "Dépendances et build ($old_rev → $new_rev)"
  if ! (cd "$APP_DIR" && npm ci --no-audit --no-fund && npm run build); then
    warn 'Update/build échoué. Les données Bedrock et .env sont conservés.'
    (( was_running )) && cmd_start || true
    return 1
  fi
  ok "Code mis à jour vers $new_rev ; aucune opération Deploy/Wipe n’a été lancée."
  (( was_running )) && cmd_start || printf 'Le panneau était arrêté ; démarre-le avec ncraft start.\n'
}

cmd_help() {
  cat <<'EOF'
Nebula Craft — gestion de l’installation et du panneau

Usage : ncraft <commande>

  setup                 Installe les dépendances, prépare .env et construit le panneau
  start                 Démarre le panneau en arrière-plan dans le conteneur
  stop                  Arrêt gracieux du panneau et de ses enfants
  restart               Redémarre le panneau
  status                État du processus, santé HTTP, mémoire et configuration masquée
  logs                  Suit les logs du panneau
  update                Pull --ff-only + npm ci + build, sans toucher au monde Bedrock
  doctor                Vérifie runtime, fichiers, le tunnel actif, libcurl et mémoire
  env                   Menu interactif de configuration .env
  env list              Liste .env en masquant les secrets
  env get CLE [--reveal] Lit une valeur (secrets masqués par défaut)
  env set CLE VALEUR    Modifie une variable sans écraser les autres
  env set PANEL_TOKEN|LOCALTONET_AUTH_TOKEN|LOCALTONET_API_KEY
                        Saisie masquée des secrets, sans les exposer dans l’historique
  env unset CLE         Supprime une variable
  env edit              Ouvre le .env dans l’éditeur

Le serveur Bedrock se démarre et s’arrête depuis le dashboard. Deploy recrée
bedrock/server ; Start/Stop ne modifient pas le monde déjà installé.
EOF
}

case "${1:-help}" in
  setup) shift; cmd_setup "$@" ;;
  start) shift; cmd_start "$@" ;;
  stop) shift; cmd_stop "$@" ;;
  restart) shift; cmd_restart "$@" ;;
  status) shift; cmd_status "$@" ;;
  logs) shift; cmd_logs "$@" ;;
  update) shift; cmd_update "$@" ;;
  doctor) shift; cmd_doctor "$@" ;;
  env) shift; cmd_env "$@" ;;
  help|--help|-h) cmd_help ;;
  *) fail "Commande inconnue : $1 (utilise ncraft help)."; exit 2 ;;
esac
