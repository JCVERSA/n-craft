<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/assets/nebula-craft-lockup-horizontal-white.svg">
    <img src="public/assets/nebula-craft-lockup-horizontal-black.svg" alt="Nebula Craft" width="560">
  </picture>
</h1>

<strong>A private, single-instance control panel for Minecraft Bedrock Dedicated Server.</strong><br>
Deploy and operate Bedrock from the Linux container you already have — without Docker-in-Docker or a database.

[![CI](https://github.com/JCVERSA/n-craft/actions/workflows/ci.yml/badge.svg?branch=arena%2F01a0e06a-n-craft)](https://github.com/JCVERSA/n-craft/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-20.19%2B%20%7C%2022.12%2B-339933.svg?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/Platform-Linux%20x86_64-5E6AD2.svg?style=for-the-badge&logo=linux&logoColor=white)](#runtime-requirements)
[![Target](https://img.shields.io/badge/Target-Bedrock%20Dedicated%20Server-65449B.svg?style=for-the-badge)](https://www.minecraft.net/en-us/download/server/bedrock)
[![No Docker](https://img.shields.io/badge/No-Docker%20or%20database-2E7D32.svg?style=for-the-badge)](#what-you-get)

[What You Get](#what-you-get) · [Quick Start](#quick-start) · [Install & Requirements](#installation-and-runtime-requirements) · [Tunnels](#network-https-and-tunnels) · [In-Game Assistant](#in-game-chat-assistant) · [Data & Safety](#persistent-data-and-security) · [Development](#development-and-validation)

</div>

<p align="center">
  <em>Nebula Craft is an independent community project. It is not affiliated with or endorsed by Microsoft or Mojang. Minecraft is a trademark of Microsoft.</em>
</p>

## What You Get

- **One control panel for one Bedrock instance.** Manage deployment, settings, server lifecycle, diagnostics, logs, and tunnel status from a browser dashboard.
- **Runs in your existing Linux container.** No Docker daemon, nested container, Dockerfile, or database is added. Configuration, state, logs, and tunnel data use local files; persist `DATA_DIR`.
- **Non-destructive deployment.** Deploy verifies and stages the server archive before applying it. Worlds, backups, custom packs, structures, and files not supplied by the archive are preserved.
- **A public UDP tunnel is optional.** Portwarp is the default provider; Localtonet and Playit remain explicit alternatives. Tunnels are created and approved by the operator, not silently provisioned by Nebula Craft.
- **An optional, tightly scoped in-game assistant.** It only reacts to messages beginning with `.. ` in Bedrock chat. It has no tools, world access, or server-command capability; replies are public to players.
- **Explicit security boundaries.** Secrets stay on the server, sensitive flows require operator action, HTTPS is required in production, and automated operations do not silently change Bedrock permissions or delete worlds.

> **Compatibility note:** The chatbot is currently restricted to the Bedrock client `1.21.130` family (protocol 898 / RakNet 11), mapped to BDS `1.21.130.3` and `1.21.130.4`. Its automated protocol test is offline and does **not** prove connectivity to the official BDS binary or real Microsoft authentication. See [In-Game Chat Assistant](#in-game-chat-assistant) before enabling it.

## Quick Start

These steps install Nebula Craft into an **existing Debian/Ubuntu Linux x86_64 container**. They do not install or start Bedrock automatically. Run the installer as root if you want it to install missing system packages; non-root containers must already have the prerequisites below.

### 1. Download and inspect the installer

```bash
curl -fsSL https://raw.githubusercontent.com/JCVERSA/n-craft/arena/01a0e06a-n-craft/scripts/install.sh -o /tmp/ncraft-install.sh
less /tmp/ncraft-install.sh
bash /tmp/ncraft-install.sh
```

The script intentionally installs or updates the `arena/01a0e06a-n-craft` branch, not `main`. Review the script before running it, especially as root. It does not start the panel or Bedrock when installation finishes.

### 2. Start the panel and retrieve its token

```bash
ncraft start
ncraft env get PANEL_TOKEN --reveal
```

Open the public **HTTPS URL** configured for your container and sign in with the token. Run the second command locally in the container only: never paste the token into chat, a dashboard field, Git, or a public issue.

### 3. Deploy and operate Bedrock

Use the authenticated dashboard to select and deploy a Bedrock build, then manage the server with **Start** and **Stop**. A successful Deploy starts Bedrock again after applying the update. Starting the panel alone does not start the game server.

Check the installation from the container with:

```bash
ncraft status
ncraft doctor
ncraft logs
```

## Installation and Runtime Requirements

### Existing-container installer

On Debian/Ubuntu amd64, the installer checks prerequisites and, when run as root with `apt`, can install missing system packages and Node.js 22. It clones or fast-forward-updates the repository, runs `npm ci --ignore-scripts`, verifies the prebuilt `raknet-node` binding used by the chatbot, and builds the panel. Optional native install scripts are skipped so `raknet-native` is not compiled. OpenPGP.js verifies Ubuntu metadata; a separate `gpgv` package is not required.

The installer installs the official Portwarp `pwrp` CLI v0.3.7 only after its pinned SHA-256 is verified. It also offers the official Playit v1.0.10 binaries as a fallback, verified by SHA-256. Localtonet is retained as an inactive alternative. The installer does not run an unreviewed Portwarp script as root.

By default, the installer reuses the current directory if it is already a clone of `JCVERSA/n-craft`; otherwise it uses `/root/n-craft` as root or `~/n-craft` as a regular user. Choose another location with:

```bash
bash /tmp/ncraft-install.sh --dir /opt/n-craft
```

The installer and `ncraft update` deliberately target `arena/01a0e06a-n-craft`, even after a long period. They use `git pull --ff-only`, refuse a dirty clone or a non-empty unrelated directory, and never replace `.env` secrets, the version catalog, or Bedrock data. The first setup creates `.env` with a random `PANEL_TOKEN` and mode `0600`; if a regular `.env` exists without a token, only that missing token is added. Migration changes the old default `TUNNEL_PROVIDER=localtonet` to `portwarp` once, recording a marker so a later explicit Localtonet choice is respected. A symlinked `.env` is never rewritten automatically: configure its target manually. A build or dependency failure does not delete the world. The installer does not start the panel or Bedrock.

For a manual installation into a clean clone:

```bash
bash scripts/install.sh --dir /path/to/n-craft
# or, from the clone:
ncraft setup
ncraft start
```

### Runtime requirements

- Linux x86_64 / amd64; the Bedrock binary used by this project does not support ARM.
- glibc 2.29 or newer, `libcurl.so.4`, `dpkg-deb`, and `ldd`.
- Node.js 20.19+ or 22.12+; Node.js 22 LTS is recommended; npm is required.

When run as root with `apt`, `scripts/install.sh` installs Node.js 22, `libcurl4`, and basic system tools when needed. `ncraft setup` can install `dpkg` and `libc-bin` if `dpkg-deb` or `ldd` is missing and it has root privileges plus `apt`. In a non-root container, Node/npm and the system packages must already be available; otherwise setup reports the missing prerequisite and stops without touching worlds. `npm ci --ignore-scripts` installs and verifies OpenPGP.js and the prebuilt `raknet-node` binding; a separate `gpgv` package and a native compiler are not required for installation.

### Legacy OpenSSL runtime

Some older BDS releases require OpenSSL 1.1, which is end-of-life. Before starting or stopping an existing server, Nebula Craft inspects the binary. If those libraries are missing, it prepares them only for that BDS version in `DATA_DIR/runtime/`, after verifying the Ubuntu `InRelease` signature, index hash, and focal package. It does not install a global package, link to OpenSSL 3, or overwrite an incomplete local runtime. Checks and downloads happen before the currently running server is stopped.

### Memory and disk

Available memory below **4 GiB** is a warning, not a hard block. The build, tunnel client, and Bedrock share the container memory limit, so an out-of-memory termination is possible. Check free disk space before Deploy as well.

## `ncraft` Command Reference

The installer creates an `ncraft` link to `manage.sh`: `/usr/local/bin` for root or `~/.local/bin` for a regular user.

| Command | Behavior |
| --- | --- |
| `ncraft setup` | Runs `npm ci --ignore-scripts`, native-binding checks, and the production build. |
| `ncraft start` | Starts the panel in the background inside the container. |
| `ncraft stop` | Gracefully stops the panel and its child processes. |
| `ncraft restart` | Restarts the panel. |
| `ncraft status` | Shows panel state, HTTP health, memory, and masked variables. |
| `ncraft logs` | Follows panel logs. |
| `ncraft update` | Fast-forward-updates `arena/01a0e06a-n-craft`, runs `npm ci --ignore-scripts`, and builds without deploying Bedrock. |
| `ncraft doctor` | Checks Node, OpenPGP, system tools, selected tunnel, build, `.env`, `libcurl`, and memory. |
| `ncraft env` | Opens the interactive `.env` menu; secrets are masked. |
| `ncraft env list` | Lists configuration without revealing secrets. |
| `ncraft env get KEY` | Reads a value; `--reveal` is required for a secret. |
| `ncraft env set KEY VALUE` | Updates one value without replacing unrelated lines. |
| `ncraft env set PANEL_TOKEN` | Opens a masked prompt; the value is not placed in shell history. |
| `ncraft env unset KEY` | Removes one key. |
| `ncraft env edit` | Opens `.env` with `$EDITOR` or `vi`. |

`ncraft start` starts only the dashboard. Start Bedrock with **Start** in the dashboard. Closing a browser tab does not stop the panel; stopping the container stops the panel and its children. Bedrock does not automatically start after a container restart: open the dashboard and start it yourself.

The panel token is never printed by `setup`, `status`, `doctor`, or `env list`. To reveal it locally in the container:

```bash
ncraft env get PANEL_TOKEN --reveal
```

Do not publish or share that output. `ncraft env set` preserves unrelated `.env` values; remove an old `PLAYIT_SECRET_KEY` with `ncraft env unset PLAYIT_SECRET_KEY` if needed.

## Network, HTTPS, and Tunnels

The panel listens on `0.0.0.0:${PORT}` (`3000` by default). In production, publish it behind TLS: interactive routes reject plain HTTP and session cookies are `Secure`. If a reverse proxy is used, set `PANEL_TRUST_PROXY` only for proxies you actually trust; set `PANEL_ORIGIN` if the exact public origin cannot be inferred. The frontend and API use the same origin.

<details>
<summary><strong>Portwarp — default provider</strong></summary>

At setup, Nebula Craft installs `pwrp` from `https://portwarp.com/download/` and checks the official pinned SHA-256 before extracting it. It does not run `curl | bash` as root. A working existing CLI is kept. Credentials stay in the private Portwarp profile of the Linux user running the panel (`~/.portwarp`), never in `.env`, Git, logs, or `data/state.json`.

On panel start or restart, Nebula Craft checks CLI authentication. If the container is not linked, it runs `pwrp login` and shows the official link and temporary device code in the dashboard tunnel section. Approve the link yourself from your authenticated Portwarp session. The code exists only in runner memory and the protected dashboard response, and is cleared when the flow ends. Do not copy it into chat or `.env`.

The tunnel must already exist in your account and have the exact name `Minecraft Bedrock` (change it with `PORTWARP_TUNNEL_NAME`). If it is missing or disabled, create or enable it **manually** in [Portwarp Tunnels](https://portwarp.com/tunnels): UDP, local target `127.0.0.1:19132`. Nebula Craft does not create, modify, or delete it. Once available, the panel detects it and runs `pwrp connect "Minecraft Bedrock" --save --detach`; the CLI saves the selection, and Nebula Craft checks/reconnects it whenever the panel starts or restarts. Bedrock Stop/Start, Deploy, and graceful panel shutdown never run `pwrp stop` or disconnect the tunnel. Nebula Craft does not configure the container to start automatically after a full host reboot.

The dashboard shows the public address and relay session status. This **does not prove** that Bedrock UDP is reachable: Portwarp's local check uses TCP, while Bedrock uses UDP. Validate the connection from a Bedrock client. Portwarp's Free plan currently advertises one active tunnel and UDP without an SLA; terms, availability, and limits may change, so no uptime is guaranteed.

</details>

<details>
<summary><strong>Localtonet — inactive alternative</strong></summary>

Localtonet code is retained, but Portwarp is the default. To deliberately enable Localtonet, set `TUNNEL_PROVIDER=localtonet` in `.env` and restart the panel. Nebula Craft does not download or replace its binary: install the official Linux client from the [Linux documentation](https://localtonet.com/documents/linux) or [downloads page](https://localtonet.com/download), then check it with `ncraft doctor`. The runner uses `--headless --authtoken-file <file>`.

If enabled, configure `LOCALTONET_AUTH_TOKEN` and `LOCALTONET_API_KEY` through `ncraft env`. Input is masked. Localtonet secrets are not returned to the browser, written to application logs, or persisted in `data/state.json`. Create the UDP `19132` tunnel manually. API status does not claim that the tunnel is reachable from the Internet.

</details>

<details>
<summary><strong>Playit — fallback option</strong></summary>

Portwarp is the default. To select Playit, set `TUNNEL_PROVIDER=playit` in `.env` and restart the panel. The installer provides official Playit v1.0.10 binaries verified by SHA-256; an existing binary is not automatically replaced.

When selected, the dashboard launches the official `playit` CLI (`PLAYIT_CLI_BIN`) to generate a claim link; the configured daemon in `PLAYIT_BIN` is attached or started without blindly launching a second daemon. Then:

1. Open the claim link and approve the agent on the Playit website.
2. Manually create/configure a **Minecraft Bedrock / UDP / local port 19132** tunnel in Playit.
3. Wait for the public address to be detected and shown in the dashboard.

`PLAYIT_SECRET_KEY` is not required in `.env` for this flow. The daemon stores its secret in a private local file; it is not exposed through the API or stored in JSON state. If the claim or tunnel is not ready, the dashboard allows Bedrock to start with a warning by default. Availability depends on the installed binary, approved claim, and manual tunnel configuration; validate every step in your environment. An incompatible older agent/CLI (for example, Playit 0.17.x) must be replaced or manually configured with a v1.x build compatible with IPC v2. The local test simulates the IPC protocol and does not prove access to the real Playit service.

</details>

## In-Game Chat Assistant

The assistant replies **in Bedrock server chat**, never in a dashboard conversation window. Its only trigger is `.. <message>` (two periods, one space, then text). Messages without this prefix are ignored and are not sent to AI providers. Prefixed messages go to Google Gemini first; NVIDIA NIM is tried only if Gemini fails. Nebula Craft does not persist chat history. V1 is conversational only: no tools, Bedrock commands, world reading, or other actions. Replies are public in server chat.

### Supported build and validation boundary

Support is strictly limited to the `1.21.130` client family (Bedrock protocol 898, RakNet 11), currently mapped in the catalog to BDS `1.21.130.3` and `1.21.130.4`. Other builds — including `1.21.131.1` — remain disabled until their protocol family is validated. Automated tests perform an offline local RakNet 11/protocol/chat round trip using the `bedrock-protocol` test client and server. They do **not** prove a connection to the official BDS binary or real Microsoft authentication. Diagnostics states this validation level; verify each BDS build in the target environment before expanding support.

### Provider setup and limits

Configure AI secrets **on the server**, through the masked `ncraft env` menu. Running `ncraft env set GEMINI_API_KEY` with no value opens a masked prompt; the same works for `NVIDIA_NIM_API_KEY`. Do not pass a key as a command-line argument, paste it into the dashboard or chat, or add it to Git. Gemini is primary; NVIDIA NIM is fallback only. Defaults are `gemini-3.8-flash` and `meta/llama-3.3-70b-instruct`; set `CHATBOT_GEMINI_MODEL` or `CHATBOT_NIM_MODEL` to change them. `CHATBOT_DAILY_LIMIT` caps accepted requests per UTC day (100 by default; `0` disables requests). Only one AI request can run at a time.

### Bedrock account linking

Linking is a separate action in **Diagnostics**, available only while Bedrock is running a compatible build and at least one AI provider is configured. Use a dedicated Microsoft/Bedrock account that is **not** an operator. Linking never begins during installation or restart: a button followed by an explicit confirmation starts the official device-code flow, which you approve yourself with Microsoft. Nebula Craft never asks for your Microsoft password.

A reconnect using an already-linked profile may happen silently, but Nebula Craft never silently requests a new device code. If Microsoft requires a new code, confirmation is required again. Nebula Craft rejects an account whose XUID appears as an operator in `permissions.json`. The bot occupies a player slot; if `allow-list=true`, add the account to the Bedrock allowlist manually. Nebula Craft does not modify `permissions.json`, `allowlist.json`, or global server settings for the assistant.

### Chatbot data and privacy

The OAuth cache stays server-side in `DATA_DIR/bedrock-chatbot/auth` (directory mode `0700`, files `0600`, atomic writes). It is never stored in `.env`, Git, JSON state, the browser, or application logs. Gemini/NIM keys remain in `.env` mode `0600` and are removed from child-process environments.

Shared player conversation memory contains only the 10 most recent exchanges that began with `..`; it expires after 30 minutes without a request and is never written to disk. It is cleared whenever Bedrock stops/restarts and whenever the panel restarts. `DATA_DIR/bedrock-chatbot/quota.json` stores only the UTC day and an aggregate count — no messages, replies, player names, or XUIDs. The dashboard does not display chat history.

## Server Lifecycle and Non-Destructive Deploy

- **Deploy requires Bedrock to be stopped.** The ZIP is verified and extracted to a temporary directory, then merged without deleting `BEDROCK_SERVER_DIR`. After an update, Bedrock starts again automatically. The tunnel is not interrupted.
- While Bedrock is online, settings and version selection are locked. After Bedrock stops, settings can be edited. **Save Settings** writes only changed values to `server.properties`/`permissions.json`, without downloading a ZIP or starting Bedrock; the server remains stopped until manually started. If the version changes, **Update & Start** applies edited settings and deploys.
- Updates preserve worlds (`worlds`), backups, custom packs, structures, and files not provided by the archive — including permissions and settings. Official global packs in the archive are refreshed only when manifest UUIDs match; a custom pack with the same name but a different UUID is not replaced. Bedrock permissions outside the panel's admin list remain intact. Changing the world name selects another directory or creates it if absent; the previous world remains untouched. The seed applies only when a new world is generated.
- If preflight, download, extraction, or dependency verification fails before shutdown, an already-running server keeps running and a stopped server stays stopped. Worlds and packs are not deleted. Copy failures are reported so the operator can retry Deploy.
- **Start** launches the installed binary without deleting or rewriting the world. **Stop** requests a graceful server shutdown. These actions do not start, stop, or delete Portwarp, Localtonet, or Playit tunnels.
- The dashboard reports player counts from Bedrock join/leave events, uptime since the last server start, and CPU/RAM for the Bedrock child process inside the container. CPU/RAM readings do not include the panel or host.
- By default, Bedrock announces a countdown from **03:55 to 04:00** and gracefully restarts every day at **04:00 Africa/Douala**. It announces once per minute and restarts even if players are connected. Configure time, timezone, warning duration, and enablement with `BDS_RESTART_TIME`, `BDS_RESTART_TIMEZONE`, `BDS_RESTART_WARNING_MINUTES`, and `BDS_RESTART_ENABLED` in `.env`, then restart the panel. After a container stop/restart, Bedrock itself remains stopped until Start; the schedule only restarts an instance that is already running.
- Nebula Craft keeps `server-port=19132`, `server-portv6=19133`, `online-mode=false`, and `allow-list=false` under panel control. Saving settings changes only requested keys and preserves unknown properties, unmanaged permissions, and world data.

## Persistent Data and Security

Mount `DATA_DIR` and, if needed, `BEDROCK_SERVER_DIR` as persistent volumes for your hosting environment. A forced container stop can still interrupt an in-progress save; allow graceful shutdown to finish.

| Path | Purpose and lifetime |
| --- | --- |
| `.env` | Secrets and configuration, including server-side Gemini/NIM keys. Kept by the installer; regular files use mode `0600`. |
| `data/state.json` | Panel, pipeline, server, and selected-tunnel state (address/status only). No Portwarp code, tunnel secret, AI key, Bedrock profile, or chat history. |
| `data/bedrock-chatbot/auth/` | Private `0700`/`0600` Microsoft OAuth cache for the dedicated Bedrock account, used only after explicit approval. |
| `data/bedrock-chatbot/quota.json` | UTC day and aggregate daily quota count; no message, reply, or player identifier. |
| `~/.portwarp/` | Private Portwarp CLI profile for the current Linux user; managed only by `pwrp`, never copied to `.env` or moved by Nebula Craft. |
| `data/server.log` | Rotating Bedrock log, limited to 10 MiB with a `.1` copy. |
| `data/panel.log`, `data/panel.pid` | `ncraft` manager log and PID. |
| `data/playit/` | Private default agent secret file; an existing Playit configuration at `~/.local/share/playit/secret.toml` may also be reused. |
| `data/versions.json` | Manually maintained catalog; never replaced by `.env` or a Deploy operation. |
| `data/runtime/` | Local OpenSSL 1.1 dependencies for older BDS versions; ignored by Git. |
| `bedrock/server/` | Persistent server binary, world, packs, and Bedrock configuration; Deploy updates it without deleting it. |

## Development and Validation

```bash
npm ci --ignore-scripts
npm run lint
npm test
npm run build
npm start
```

`data/versions.json` is a manually maintained catalog of **160 stable builds**, from BDS `1.6.1.0` through `1.21.131.1` (client versions strictly below `1.21.132`), including `1.19.50.02`. URLs use the official Minecraft HTTPS format, though historical archives may become unavailable. During Deploy, the backend rejects unapproved hosts, checks the response, size, and ZIP format, then extracts without zip-slip or symbolic links. An unavailable URL fails before stopping a running server; the catalog is not automatically trimmed.

The automated suite covers non-destructive startup, conditional ELF/OpenSSL dependency checks, global-pack refresh without replacing custom packs, simulated Portwarp/Localtonet/Playit runners, the private OAuth cache, AI quota/memory, child-process environment filtering, and an offline RakNet 11 loop. These tests do not replace testing against the official BDS `1.21.130.x` binary, a Microsoft flow approved by an operator, real tunnel clients, live BDS archives, or Ubuntu download/signature verification in the target environment.

The GitHub Actions workflow runs TypeScript typechecking, tests, and a production build on Ubuntu with Node.js 22. The native `raknet-native` addon is intentionally not built or exercised by CI; the chatbot uses the prebuilt `raknet-node` binding.

## Project Links

- [Report a bug or request a feature](https://github.com/JCVERSA/n-craft/issues)
- [CI workflow](https://github.com/JCVERSA/n-craft/actions/workflows/ci.yml)
- [Nebula Craft brand guidelines](docs/branding/nebula-craft-guidelines.md)
- [Install script](scripts/install.sh)

No `LICENSE` file is currently included in this repository, so no license badge is shown.
