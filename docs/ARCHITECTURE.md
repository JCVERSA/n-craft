# Nebula Craft — Architecture & Security Reference

Nebula Craft (`n-craft`) is a single-instance control panel for **Minecraft Bedrock Dedicated Server (BDS)** designed to run inside an existing Debian/Ubuntu `x86_64` container without Docker-in-Docker or an external database.

---

## 1. System Topology

```text
Browser (React 19 SPA, self-hosted Space Grotesk & JetBrains Mono)
  │  Same-origin HTTPS + HttpOnly/SameSite=Strict session cookie
  ▼
server.ts (Express 4 + ws WebSocket server on /api/server/console)
  ├── Auth & Security     src/auth.ts, src/security.ts, src/audit.ts
  ├── REST Routers        src/routes/{auth,server,pixelStudio}.routes.ts
  ├── Persistent State    src/state.ts (atomic JSON; 5s CPU/RAM kept in memory)
  ├── BDS Core            src/bedrock/
  │   ├── deployPipeline.ts, installRelease.ts, configWriter.ts
  │   ├── console.ts (child_process stdin/stdout + BoundedLogFile + WS gateway)
  │   ├── worldManager.ts, packManager.ts, snapshots.ts, recovery.ts
  │   └── runtimeDependencies.ts, scheduler.ts, processMetrics.ts, playerRoster.ts
  ├── Tunnels             src/portwarp/, src/playit/, src/localtonet/
  ├── Monitoring & Probe  src/preflight.ts, src/monitoring.ts, src/networkProbe.ts, src/diagnostics.ts
  ├── In-Game Chatbot     src/bedrock/chatbot/ (protocol 898 / 1.21.130 only)
  └── Pixel Studio AI     src/pixelStudio/aiService.ts
```

---

## 2. Frontend Module Structure

- `src/App.tsx` — Mounts `DialogProvider` (`NebulaModal`) and `LivePanelView`.
- `src/views/LivePanelView.tsx` — Session lifecycle, status/world polling, `/api/server/console` WebSocket client (including immediate logout on close code `4401`), hash-synced navigation, and lazy tab orchestration.
- `src/views/panel/`
  - `panelHelpers.ts` — Shared types, tab metadata, API client (`apiRequest`), byte/duration formatters, and configuration validators.
  - `PanelPrimitives.tsx` — `PanelHeading`, `StatusPill`, `LiveUptime`, `MetricTile`, `WorldDetail`, `CheckRow`, and `PanelLoadingFallback`.
  - `PanelLoginView.tsx` — Unauthenticated `PANEL_TOKEN` / named-account sign-in view.
  - `OverviewPanel.tsx` — Eagerly loaded landing tab (server lifecycle hero, tunnel relay status, live CPU/RAM chart, active world summary).
  - `DeployPanel.tsx` *(lazy)* — BDS version cartridge picker, world radio selector, gameplay properties, and `admin`+-gated `adminXuids` editor.
  - `WorldsPanel.tsx` *(lazy)* — Isolated per-version world manager (recursive `sizeBytes` display, import/export/rename/delete) and per-world Bedrock pack manager.
  - `DiagnosticsPanel.tsx` *(lazy)* — In-game chatbot status/device-flow controls, real-time deploy pipeline stepper, and container preflight checks.
  - `ConsolePanel.tsx` *(lazy)* — Live Bedrock `stdin`/`stdout` console over WebSocket.
- `src/views/OperationsView.tsx` *(lazy)* — Online/offline snapshots, RakNet UDP ping probes, crash recovery, resource alerts, player/XUID roster, `owner` account management, redacted diagnostics export, and audit log.
- `src/views/PixelStudioView.tsx` *(lazy)* — Browser-local sprite & animation editor with optional `operator`+ AI generation.

---

## 3. Security & RBAC Model

### Authentication & Transport
- **Owner credential**: `PANEL_TOKEN` in `.env` (`0600`), verified with constant-time comparison and rejected if left at the example placeholder.
- **Named accounts**: `admin`, `operator`, and `viewer` stored in `data/panel-users.json` (`0600`) using random salts and `crypto.scrypt`.
- **Sessions**: In-memory session map (`nebula_panel_session` cookie: `HttpOnly`, `SameSite=Strict`, `Path=/`, `Secure` when `NODE_ENV=production`), capped with oldest-session eviction.
- **Transport & CSRF**: In production (`NODE_ENV=production`), `requireHttpsInProduction` and `isHttpsRequest` reject plain HTTP on both Express routes (except `/api/health`) and `/api/server/console` WebSocket upgrades. All state-changing HTTP routes and WebSocket upgrades enforce `isSameOriginRequest` (`Origin` / `Referer` verification respecting explicit `PANEL_TRUST_PROXY`).
- **Live revocation**: `PanelAuthService.onSessionChange` notifies active `/api/server/console` WebSockets whenever a session is logged out, deleted, or re-roled; revoked sockets close immediately with code `4401`.

### Role Enforcement & Redaction
- **`viewer`**: Read-only access. World `seed`s, `adminXuids`, observed admin lists (`GET /api/server/players`), and ephemeral setup/claim codes (Portwarp, Playit, Microsoft device code) are redacted across REST and WebSocket payloads. Cannot download `.mcworld` exports or snapshots, send console commands, or invoke Pixel Studio AI.
- **`operator`**: Operational control (start/stop, deploy, gameplay settings, world import/rename/export, manual snapshot creation & download, standard console commands, tunnel/chatbot linking, Pixel Studio AI). Cannot delete worlds, modify `adminXuids`, restore/delete/schedule snapshots, import/activate Bedrock packs, edit crash-recovery/monitoring settings, or send privileged console commands (`op`, `deop`, `allowlist`, `whitelist`, `permission`, `reload`).
- **`admin`**: Full server, world, pack, snapshot, recovery, monitoring, `adminXuids`, privileged console, and audit-log access.
- **`owner`**: All `admin` privileges plus creating, re-roling, and deleting panel user accounts.

---

## 4. Storage & Safety Invariants

1. **Non-destructive `BEDROCK_SERVER_DIR`**: `assertSafeServerDirectory` requires `path.basename(BEDROCK_SERVER_DIR) === 'server'`, forbids overlap with `DATA_DIR` or the repository root, and checks every ancestor against symlinks before mutating files.
2. **Version-isolated worlds**: Each managed world in `data/worlds.json` is bound to an exact BDS version and a server-generated folder (`worlds/ncraft_<hex>`), preventing accidental cross-version LevelDB corruption.
3. **Online snapshot consistency (`src/bedrock/snapshots.ts`)**:
   - Sends `save hold`, polls `save query`, copies exact byte lengths for `db/*` and root world metadata (`ONLINE_WORLD_ROOT_FILES`), captures existing non-symlink root sidecar files (`world_behavior_packs.json`, `world_resource_packs.json`, pack history, `levelname.txt`, world icon) within strict entry/byte/disk-headroom limits, and guarantees `save resume` execution in `finally` (including during `SIGTERM`/`SIGINT` shutdown).
4. **Legacy OpenSSL 1.1 isolation (`src/bedrock/runtimeDependencies.ts`)**:
   - Inspects `bedrock_server` ELF `DT_NEEDED` entries via `ldd`. Only when `libssl.so.1.1` / `libcrypto.so.1.1` are missing does it fetch `focal-updates` metadata, verify Canonical's pinned OpenPGP signature (`InRelease` floor `2025-01-01`, max 24h future skew, minimum patch `1.1.1f-1ubuntu2.22`) and SHA-256 package digest, and unpack into `DATA_DIR/runtime/` scoped via `LD_LIBRARY_PATH` to that child process alone.
5. **Child-process secret scrubbing (`src/bedrock/childEnv.ts`)**: Strips `PANEL_TOKEN`, `GEMINI_API_KEY`, `NVIDIA_NIM_API_KEY`, `LOCALTONET_*`, `PLAYIT_SECRET_KEY`, and other panel secrets before spawning `bedrock_server` or tunnel binaries.
