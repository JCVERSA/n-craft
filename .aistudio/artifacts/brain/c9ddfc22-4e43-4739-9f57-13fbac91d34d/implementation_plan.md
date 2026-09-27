# Nebula Craft Console: Professional Taste & Emil Kowalski Motion Overhaul

An end-to-end refinement of the Nebula Craft Bedrock Dedicated Server (BDS) console that harmonizes pure diegetic Minecraft aesthetics (stone bevels, pixel typography, chest matrices, F3 telemetry) with professional design discipline (UI/UX Pro Max, high-taste visual balance, zero-pill metadata, 60-30-10 palette rules) and tactile, interruptible Emil Kowalski physics-based spring animations.

---

## User Review & Critical Decisions

> [!IMPORTANT]
> The user confirmed the aesthetic direction: **Pure Diegetic Minecraft (Retro pixelated blocky GUI borders and retro font)**, with **all visual and sensory enhancements prioritized** (animations, high-taste typography, audio haptics, and professional spatial hierarchy).

- **Confirmed Aesthetic**: Pure Diegetic Minecraft (`.mc-bevel`, `.mc-stone-btn`, `.mc-gui-window`, `.mc-slot`, `Press Start 2P`, `Silkscreen`, `Space Mono`, `VT323`, `JetBrains Mono`).
- **Confirmed Enhancements**: All visual & sensory improvements (Emil Kowalski spring physics, high-contrast accessible color tokens, refined padding & typography rhythm, diegetic audio feedback).
- **Zero Loss of Capabilities**: All 5 views (`dashboard`, `operator-auth`, `chest-matrix`, `node-pipeline`, `f3-telemetry`), live command terminal, real-time audio synthesizer, hotbar shortcuts, and simulated server lifecycle remain completely functional.

---

## 1. Overview & Core Concept

- **What It Does**: A production-grade web management suite for Minecraft Bedrock Dedicated Servers (BDS) that feels like an authentic in-game HUD and terminal console. It combines live log telemetry, 54-slot chest inventory management, command block node topologies, and F3 telemetry with smooth, modern interface polish.
- **Target Audience / Persona**: Minecraft server administrators, realm operators, and enthusiasts who appreciate genuine in-game lore and skeuomorphism without sacrificing responsiveness, speed, and clean typography.
- **Key Value**: Delivers the tactile feel of Minecraft GUIs with the responsiveness, animation fluidity, and usability of a modern developer console.

---

## 2. User Experience & Visual Design

### Visual Identity & Theme
- **Color Palette & 60-30-10 Discipline**:
  - **60% Neutral Canvas**: Deep bedrock obsidian (`#121214`), dark stone surface (`#1B1C1D`), and recessed slot slate (`#0E0E0F`).
  - **30% Structural Surfaces**: Classic Minecraft GUI gray (`#C6C6C6` with 3D stone bevels) and terminal slate cards (`#1E1F21` with `.mc-bevel` borders).
  - **10% Intentional Accents**: 
    - *Emerald XP Green* (`#7CBB43` / `#97D85D`): Active server state, healthy 20.0 TPS, XP level badges, success logs.
    - *Redstone Torch Coral* (`#FF5555` / `#FF8782`): Critical warnings, stop triggers, error spikes.
    - *Golden Glowstone* (`#FFE55C` / `#FDE35A`): MOTD highlights, active selection indicators, hover rings.
    - *Lapis / Diamond Cyan* (`#55FFFF` / `#4DEEEA`): Packet latency, active tab glides, portal nodes.
- **Anti-Slop & Zero-Pill Restraint**:
  - Remove all rounded static pill tags in favor of crisp Minecraft pixel boxes and clean unboxed metadata separated by middots (`·`).
  - Strict 2+1 font hierarchy: `Press Start 2P` & `Silkscreen` for authentic retro display/headers; `Space Mono` & `JetBrains Mono` with `tabular-nums` for telemetry, numbers, and logs.
  - Eliminated fake AI scoreboards or arbitrary gimmicks; all counters map directly to simulated BDS server properties and runtime metrics.

### Motion & Emil Kowalski Spring System (`motion/react`)
- **Physics Specifications**:
  - Interactive micro-presses: `stiffness: 500, damping: 30` with `scale: 0.96` on tap.
  - View reveals & modals: `stiffness: 400, damping: 28` with subtle vertical travel (`y: 6 -> 0`).
  - Active Tab & Filter Glides: `layoutId` gliding pill behind active view buttons and terminal categories.
  - Morphing States: Smooth icon transitions with `AnimatePresence mode="wait"` for copy, pause/play, and download actions.
  - Accessible Motion: Full `@media (prefers-reduced-motion)` honoring via CSS and Framer Motion motion configurations.

---

## 3. Key Product Decisions & Enhancements

1. **Header & Navigation Polish**:
   - Apply Top Bar Contract: Brand mark on the left, 5 single-line view navigation tabs with an animated sliding highlight in the center, and Server State + Audio Mute + Alex Profile avatar on the right.
   - Distinctive active view glide indicator with zero layout shift.
2. **Dashboard View Refinements**:
   - High-density server HUD with crisp tabular metrics (TPS, Memory, CPU, Players).
   - Crafting-style Bedrock Properties form with clear visual grouping, tactile stone toggle buttons, and instant validation.
   - Diegetic stdout terminal with colored syntax highlighting, log filtering tabs, and quick-macro buttons with spring press states.
3. **Chest Matrix View & In-Game Tooltips**:
   - Polished 54-slot inventory grid with authentic slot lighting, hover states, and floating tooltip lore cards.
   - Working Anvil station for renaming MOTD with sound triggers.
   - Slide-over player chat drawer with keyboard shortcut trigger (`T`).
4. **Node Pipeline & F3 Telemetry Polish**:
   - Clean SVG redstone wiring with pulsing energy particles.
   - Precise 24-tick frame-time bar chart with smooth real-time tick height updates.
   - Clean CRT scanline simulation with phosphor glow that remains readable and accessible.
5. **Interactive Audio System**:
   - Web Audio API synthesizer for retro 8-bit stone clicks, anvil strikes, XP orb chimes, and alert tones with global volume/mute memory.

---

## 4. Technical Architecture & Component Hierarchy

```
┌────────────────────────────────────────────────────────────────────────┐
│                          App.tsx (Main Shell)                          │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │               ServerProvider (Global Context Store)            │   │
│   │   - Server State (RUNNING, STOPPED, DEPLOYING, RESTARTING)     │   │
│   │   - Telemetry (TPS, Memory, CPU, Player Load, Network Ping)   │   │
│   │   - Server Properties (MOTD, Gamemode, Difficulty, Cheats)     │   │
│   │   - Terminal Logs (Live stdout/stderr stream & macros)         │   │
│   │   - Sound Synth Engine (Web Audio 8-bit Sound FX)              │   │
│   └────────────────────────────────────────────────────────────────┘   │
│                                │                                       │
│   ┌────────────────────────────▼───────────────────────────────────┐   │
│   │               Header.tsx (Top Bar Contract)                    │   │
│   │   - Brand Crest & Status Pulse                                 │   │
│   │   - 5-View Segmented Tab Switcher (layoutId active glider)     │   │
│   │   - Audio Mute Toggle, Quick Reboot & AlexMiner Avatar         │   │
│   └────────────────────────────────────────────────────────────────┘   │
│                                │                                       │
│   ┌────────────────────────────▼───────────────────────────────────┐   │
│   │                     Active View Switcher                       │   │
│   │   ├── DashboardView.tsx      (BDS Console & Config Forms)      │   │
│   │   ├── OperatorAuthView.tsx   (Direct Connection & Token Gate)  │   │
│   │   ├── ChestMatrixView.tsx    (54-Slot Double Chest & Anvil)    │   │
│   │   ├── NodePipelineView.tsx   (Command Block Graph & Combat)    │   │
│   │   └── F3TelemetryView.tsx    (F3 Debug Screen & CRT Console)   │   │
│   └────────────────────────────────────────────────────────────────┘   │
│                                │                                       │
│   ┌────────────────────────────▼───────────────────────────────────┐   │
│   │               HotbarDock.tsx (Persistent Bottom HUD)           │   │
│   │   - 9 Diegetic Quick Action Slots (Keys 1-9)                   │   │
│   │   - Fluid Level 30 XP Progress Meter                           │   │
│   └────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
```

### Component State & Interaction Strategy
- **State Preservation**: Switching between views maintains real-time logs, active configuration changes, and ongoing simulated server operations.
- **Micro-Interactions**: Every button uses `motion.button` with `whileHover={{ y: -1 }}` and `whileTap={{ scale: 0.96 }}` for crisp tactile feedback.
- **Sound Pairing**: Every action triggers authentic Web Audio procedural sound effects (click, level up, anvil, redstone toggle).
