#!/usr/bin/env bash
set -euo pipefail

VERSION='0.3.7'
ARCHIVE="pwrp-${VERSION}-linux-amd64.tar.gz"
URL="https://portwarp.com/download/${ARCHIVE}"
SHA256='867352c774aba767e95a0726c1bce3f4b9ec2a601c751af091e1ed9887f199de'

if command -v pwrp >/dev/null 2>&1; then
  if pwrp version >/dev/null 2>&1; then
    printf 'Portwarp CLI déjà présent et vérifié par pwrp version (%s).\n' "$(command -v pwrp)"
    exit 0
  fi
  printf 'Avertissement : pwrp existe dans le PATH, mais pwrp version a échoué; aucun binaire existant ne sera écrasé.\n' >&2
  exit 1
fi

ensure_tools() {
  local missing=()
  for tool in curl tar sha256sum install; do
    command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
  done
  ((${#missing[@]} == 0)) && return 0

  if [[ "$(id -u)" -eq 0 ]] && command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y ca-certificates curl tar coreutils
    return 0
  fi
  printf 'Dépendances manquantes pour installer pwrp : %s.\n' "${missing[*]}" >&2
  return 1
}

ensure_tools

if [[ "$(id -u)" -eq 0 ]]; then
  install_dir='/usr/local/bin'
else
  install_dir="${HOME:?HOME doit être défini}/.local/bin"
  mkdir -p "$install_dir"
fi
mkdir -p "$install_dir"
target="${install_dir}/pwrp"
if [[ -e "$target" || -L "$target" ]]; then
  printf 'Le fichier %s existe déjà; il ne sera pas remplacé automatiquement.\n' "$target" >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
cleanup() { rm -rf -- "$tmp_dir"; }
trap cleanup EXIT HUP INT TERM
archive_path="${tmp_dir}/${ARCHIVE}"
printf 'Téléchargement Portwarp CLI v%s depuis le domaine officiel…\n' "$VERSION"
curl --fail --silent --show-error --location --retry 2 --connect-timeout 15 "$URL" --output "$archive_path"
printf '%s  %s\n' "$SHA256" "$archive_path" | sha256sum --check --status
printf 'SHA-256 vérifié.\n'

tar -tzf "$archive_path" | grep -Eq '(^|/)pwrp$'
tar -xzf "$archive_path" -C "$tmp_dir" pwrp
if [[ ! -f "${tmp_dir}/pwrp" ]]; then
  printf 'Archive Portwarp vérifiée, mais le binaire pwrp est absent.\n' >&2
  exit 1
fi
chmod 0755 "${tmp_dir}/pwrp"
if ! "${tmp_dir}/pwrp" version >/dev/null 2>&1; then
  printf 'Le binaire pwrp vérifié par SHA-256 ne passe pas son auto-test de version.\n' >&2
  exit 1
fi
install -m 0755 "${tmp_dir}/pwrp" "$target"
printf 'Portwarp CLI v%s installé, vérifié par SHA-256 et pwrp version : %s\n' "$VERSION" "$target"
if [[ "$install_dir" == "${HOME:-}/.local/bin" ]]; then
  printf 'Ajoute %s au PATH pour les prochaines sessions si nécessaire.\n' "$install_dir"
fi
