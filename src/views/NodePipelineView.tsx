import { useState } from 'react';
import { motion } from 'motion/react';
import { useServer } from '../context/ServerContext.tsx';
import { useDialogs } from '../components/DialogProvider.tsx';
import { ASSETS, GameMode } from '../types/server.ts';
import { playClickSound, playLeverSound } from '../utils/audio.ts';

export function NodePipelineView() {
  const {
    properties,
    updateProperties,
    telemetry,
    operators,
    addOperator,
    removeOperator,
    executeCommand,
    formatUptime,
    logs,
    clearLogs,
  } = useServer();

  const dialogs = useDialogs();
  const [cmdInput, setCmdInput] = useState('');
  const [newXuid, setNewXuid] = useState('');

  const handleExec = () => {
    if (!cmdInput.trim()) return;
    executeCommand(cmdInput);
    setCmdInput('');
  };

  const handleEnrollXuid = async () => {
    if (!newXuid.trim()) return;
    if (!/^\d{16}$/.test(newXuid.trim())) {
      await dialogs.alert({
        title: 'XUID invalide',
        message: 'L’identifiant Xbox (XUID) doit contenir exactement 16 chiffres.',
        eyebrow: 'VALIDATION · OPÉRATEUR',
        tone: 'warning',
      });
      return;
    }
    addOperator('Agent_' + newXuid.slice(-4), newXuid.trim(), 4);
    setNewXuid('');
  };

  return (
    <div className="w-full max-w-[1800px] mx-auto p-3 sm:p-4 blueprint-grid flex flex-col gap-4 pb-28">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
        {/* LEFT COLUMN: Holographic Scanner & Hardware Telemetry */}
        <div className="lg:col-span-3 flex flex-col gap-4">
          {/* Holographic Scanner Card */}
          <div className="mc-bevel bg-[#1b1c1c] p-3 relative overflow-hidden">
            <div className="flex items-center justify-between pb-2 mb-2 border-b-2 border-[#343535]">
              <span className="font-silk text-xs text-[#97d85d] font-bold flex items-center gap-1">
                <span className="material-symbols-outlined text-sm">radar</span>
                BEACON CONDUIT FREQUENCY
              </span>
              <span className="font-pixel text-[8px] text-[#dfc740]">AURA 100%</span>
            </div>

            <div className="relative bg-[#0e0e0e] mc-inset p-2 flex flex-col items-center justify-center">
              <div className="relative w-40 h-40 my-1 border-2 border-[#97d85d]/40 mc-bevel-green overflow-hidden bg-black/60 flex items-center justify-center">
                <img
                  src={ASSETS.BEACON_LOGO}
                  alt="Beacon Conduit"
                  className="w-full h-full object-cover"
                />
                <div className="absolute inset-0 bg-gradient-to-b from-[#97d85d]/10 via-transparent to-[#97d85d]/20 pointer-events-none animate-pulse" />
                <div className="absolute bottom-1 right-1 bg-[#0e0e0e]/90 px-1 font-vt text-xs text-[#97d85d]">
                  SCAN: CHAN-19132
                </div>
              </div>

              <div className="w-full mt-2 font-vt text-sm flex justify-between text-[#c2c9b5] px-1">
                <span>
                  TRANSMIT: <strong className="text-[#97d85d]">4-TIER PYRAMID</strong>
                </span>
                <span>
                  CHUNKS: <strong className="text-[#dfc740]">16 ACTIVE</strong>
                </span>
              </div>
            </div>

            {/* Telemetry Blocky ASCII Graphs */}
            <div className="mt-3 flex flex-col gap-2 font-vt text-sm">
              <div className="flex justify-between items-center text-xs">
                <span className="text-[#c2c9b5] font-silk text-[9px]">TICK BUS STABILITY (TPS)</span>
                <span className="text-[#97d85d] font-bold">20.00 / 20.00</span>
              </div>
              <div className="mc-inset bg-[#0e0e0e] p-1.5 text-[#97d85d] text-xs leading-none tracking-widest font-mono">
                [████████████████████████] 100%
              </div>

              <div className="flex justify-between items-center text-xs mt-1">
                <span className="text-[#c2c9b5] font-silk text-[9px]">HEAP ALLOCATION (RAM)</span>
                <span className="text-[#dfc740] font-bold">
                  {telemetry.ramUsedMb} MB / {telemetry.ramTotalMb} MB
                </span>
              </div>
              <div className="mc-inset bg-[#0e0e0e] p-1.5 text-[#dfc740] text-xs leading-none tracking-widest font-mono">
                [███████████░░░░░░░░░░░░░] 47.5%
              </div>

              <div className="flex justify-between items-center text-xs mt-1">
                <span className="text-[#c2c9b5] font-silk text-[9px]">CPU RENDER THREADS</span>
                <span className="text-[#97d85d] font-bold">4 CORES ({telemetry.cpuPercent}% LOAD)</span>
              </div>
              <div className="mc-inset bg-[#0e0e0e] p-1.5 text-[#97d85d] text-xs leading-none tracking-widest font-mono">
                [████░░░░░░░░░░░░░░░░░░░░] 18.0%
              </div>
            </div>
          </div>

          {/* Quick Hardware Signals */}
          <div className="mc-inset bg-[#0e0e0e] p-3 flex flex-col gap-2">
            <span className="font-silk text-xs text-[#dfc740] font-bold flex items-center gap-1.5">
              <span className="material-symbols-outlined text-sm">memory</span>
              DEPLOYMENT CONSTRUCT
            </span>
            <div className="grid grid-cols-2 gap-1.5 font-silk text-[9px]">
              <button
                type="button"
                onClick={() => executeCommand('/save-all')}
                className="mc-stone-btn bg-[#1f2020] p-2 text-[#e4e2e2] hover:text-[#97d85d] flex items-center gap-1.5"
              >
                <span className="material-symbols-outlined text-xs text-[#97d85d]">save</span>
                <span>WORLD FLUSH</span>
              </button>
              <button
                type="button"
                onClick={() => executeCommand('/tps')}
                className="mc-stone-btn bg-[#1f2020] p-2 text-[#e4e2e2] hover:text-[#dfc740] flex items-center gap-1.5"
              >
                <span className="material-symbols-outlined text-xs text-[#dfc740]">speed</span>
                <span>POLL TICK</span>
              </button>
              <button
                type="button"
                onClick={() => executeCommand('/weather clear')}
                className="mc-stone-btn bg-[#1f2020] p-2 text-[#e4e2e2] hover:text-[#97d85d] flex items-center gap-1.5"
              >
                <span className="material-symbols-outlined text-xs text-[#97d85d]">wb_sunny</span>
                <span>CLEAR SKY</span>
              </button>
              <button
                type="button"
                onClick={() => executeCommand('/kill @e[type=item]')}
                className="mc-stone-btn bg-[#1f2020] p-2 text-[#e4e2e2] hover:text-[#ff8782] flex items-center gap-1.5"
              >
                <span className="material-symbols-outlined text-xs text-[#ff8782]">delete_sweep</span>
                <span>SWEEP DROPS</span>
              </button>
            </div>
            <div className="mt-2 p-2 mc-bevel bg-[#1f2020] flex items-center justify-between font-vt text-sm">
              <span className="text-[#c2c9b5]">ENGINE UPTIME:</span>
              <span className="text-[#97d85d] font-bold font-mono">
                {formatUptime(telemetry.uptimeSeconds)}
              </span>
            </div>
          </div>
        </div>

        {/* CENTER COLUMN: Visual Node Pipeline & Recipe Matrix */}
        <div className="lg:col-span-6 flex flex-col gap-4">
          {/* Visual Node Diagram */}
          <div className="mc-bevel bg-[#1f2020] p-3 sm:p-4 relative">
            <div className="flex items-center justify-between pb-2 mb-3 border-b-2 border-[#0e0e0e]">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 bg-[#dfc740] text-[#393000] font-pixel text-[9px] flex items-center justify-center mc-bevel font-bold">
                  CB
                </div>
                <div>
                  <h2 className="font-silk text-xs sm:text-sm font-bold text-[#dfc740]">
                    VISUAL NODE PIPELINE // BDS TOPOLOGY
                  </h2>
                  <p className="font-vt text-xs text-[#c2c9b5]">
                    Active Blueprint: Bedrock Runtime -&gt; server.properties -&gt; Permissions
                  </p>
                </div>
              </div>
              <span className="bg-[#7cbb43] text-[#1b3700] px-2 py-0.5 font-pixel text-[8px] font-bold">
                ACTIVE BUS
              </span>
            </div>

            {/* 3 Nodes */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 relative z-10">
              {/* Node 1 */}
              <div className="mc-inset bg-[#0e0e0e] p-2.5 flex flex-col justify-between border-t-2 border-[#97d85d]">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-pixel text-[8px] text-[#97d85d]">NODE 01</span>
                    <span className="w-2 h-2 bg-[#97d85d] mc-bevel" />
                  </div>
                  <div className="font-silk text-xs text-white font-bold">BDS ENGINE CORE</div>
                  <div className="font-vt text-sm text-[#c2c9b5] mt-1">Dedicated Server v1.21.30</div>
                </div>
                <div className="mt-3 pt-2 border-t border-[#343535] flex items-center justify-between font-vt text-xs">
                  <span className="text-[#dfc740]">PORT 19132</span>
                  <span className="bg-[#1f2020] px-1 text-[#97d85d]">UDP BIND</span>
                </div>
              </div>

              {/* Node 2 */}
              <div className="mc-inset bg-[#0e0e0e] p-2.5 flex flex-col justify-between border-t-2 border-[#dfc740]">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-pixel text-[8px] text-[#dfc740]">NODE 02</span>
                    <span className="w-2 h-2 bg-[#dfc740] mc-bevel" />
                  </div>
                  <div className="font-silk text-xs text-white font-bold">CRAFT RECIPE MATRIX</div>
                  <div className="font-vt text-sm text-[#c2c9b5] mt-1">server.properties & Rules</div>
                </div>
                <div className="mt-3 pt-2 border-t border-[#343535] flex items-center justify-between font-vt text-xs">
                  <span>MODE: {properties.gamemode}</span>
                  <span className="bg-[#1f2020] px-1 text-[#dfc740]">CONFIG_OK</span>
                </div>
              </div>

              {/* Node 3 */}
              <div className="mc-inset bg-[#0e0e0e] p-2.5 flex flex-col justify-between border-t-2 border-[#97d85d]">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-pixel text-[8px] text-[#97d85d]">NODE 03</span>
                    <span className="w-2 h-2 bg-[#97d85d] mc-bevel" />
                  </div>
                  <div className="font-silk text-xs text-white font-bold">WORLD CONTAINER</div>
                  <div className="font-vt text-sm text-[#c2c9b5] mt-1 truncate">{properties.levelName}</div>
                </div>
                <div className="mt-3 pt-2 border-t border-[#343535] flex items-center justify-between font-vt text-xs">
                  <span className="text-[#97d85d]">SEED: {properties.seed.slice(0, 8)}</span>
                  <span className="bg-[#1f2020] px-1 text-[#97d85d]">SYNCED</span>
                </div>
              </div>
            </div>

            {/* Pulsing Redstone SVG Wire */}
            <svg className="w-full h-8 my-1" fill="none" viewBox="0 0 600 24">
              <path
                className="redstone-wire"
                d="M 100 12 L 300 12 L 500 12"
                stroke="#ff8782"
                strokeWidth="3"
              />
              <circle cx="100" cy="12" r="4" fill="#93000a" stroke="#ff8782" strokeWidth="2" />
              <circle cx="300" cy="12" r="4" fill="#93000a" stroke="#ff8782" strokeWidth="2" />
              <circle cx="500" cy="12" r="4" fill="#93000a" stroke="#ff8782" strokeWidth="2" />
            </svg>

            {/* Ingestion Capacitor */}
            <div className="mc-inset bg-[#0e0e0e] p-2.5 flex flex-col gap-1.5 mt-1 font-vt">
              <div className="flex justify-between text-xs">
                <span className="text-[#97d85d] flex items-center gap-1 font-silk text-[9px]">
                  <span className="material-symbols-outlined text-xs">schema</span>
                  PIPELINE INGESTION: BDS-BEDROCK-PULL
                </span>
                <span className="text-[#dfc740] font-pixel text-[8px]">STEP 3/6 // 78% CHARGED</span>
              </div>
              <div className="h-2.5 w-full bg-[#1b1c1c] mc-inset flex overflow-hidden">
                <div className="h-full bg-[#97d85d] w-2/6" />
                <div className="h-full bg-[#97d85d] w-2/6" />
                <div className="h-full bg-[#dfc740] w-1/6 animate-pulse" />
                <div className="h-full bg-[#343535] flex-1" />
              </div>
            </div>
          </div>

          {/* Config Recipe Slots */}
          <div className="mc-bevel bg-[#1f2020] p-3 sm:p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between pb-2 border-b-2 border-[#0e0e0e]">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-[#dfc740]">tune</span>
                <span className="font-silk text-xs sm:text-sm font-bold text-[#dfc740]">
                  CONFIG RECIPE SLOTS // server.properties
                </span>
              </div>
              <span className="font-pixel text-[8px] text-[#97d85d] mc-inset bg-[#0e0e0e] px-2 py-0.5">
                LOCKED RECIPE
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label className="font-silk text-[9px] text-[#c2c9b5] uppercase">
                  SERVER BROADCAST MOTD *
                </label>
                <div className="mc-inset bg-[#0e0e0e] p-1.5 flex items-center gap-1 font-vt text-lg">
                  <span className="text-[#97d85d]">&gt;</span>
                  <input
                    type="text"
                    value={properties.motd}
                    onChange={(e) => updateProperties({ motd: e.target.value })}
                    className="bg-transparent text-[#e4e2e2] w-full outline-none"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <label className="font-silk text-[9px] text-[#c2c9b5] uppercase">
                  ACTIVE WORLD DIRECTORY *
                </label>
                <div className="mc-inset bg-[#0e0e0e] p-1.5 flex items-center gap-1 font-vt text-lg">
                  <span className="text-[#97d85d]">&gt;</span>
                  <input
                    type="text"
                    value={properties.levelName}
                    onChange={(e) => updateProperties({ levelName: e.target.value })}
                    className="bg-transparent text-[#97d85d] w-full outline-none"
                  />
                </div>
              </div>
            </div>

            {/* Game Mode / Difficulty quick matrix */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
              <div className="flex flex-col gap-1">
                <span className="font-silk text-[9px] text-[#c2c9b5]">DEFAULT GAME MODE</span>
                <div className="grid grid-cols-3 gap-1">
                  {(['SURVIVAL', 'CREATIVE', 'ADVENTURE'] as GameMode[]).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => updateProperties({ gamemode: m })}
                      className={`p-1.5 font-silk text-[8px] font-bold text-center ${
                        properties.gamemode === m
                          ? 'mc-bevel bg-[#343535] text-[#dfc740] border-t-2 border-l-2 border-[#dfc740]'
                          : 'mc-stone-btn bg-[#1f2020] text-[#c2c9b5]'
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>

              {/* Redstone Command Hooks */}
              <div className="mc-inset bg-[#0e0e0e] p-2 flex items-center justify-between">
                <div>
                  <div className="font-silk text-[9px] text-white">REDSTONE COMMAND HOOKS</div>
                  <div className="font-vt text-xs text-[#c2c9b5]">Allow /give & command scripts</div>
                </div>
                <button
                  type="button"
                  onClick={() => updateProperties({ allowCheats: !properties.allowCheats })}
                  className="flex items-center gap-2 px-2.5 py-1 bg-[#1f2020] mc-bevel"
                >
                  <span
                    className={`font-silk text-[8px] font-bold ${
                      properties.allowCheats ? 'text-[#97d85d]' : 'text-[#c2c9b5]'
                    }`}
                  >
                    {properties.allowCheats ? 'POWER: ON' : 'POWER: OFF'}
                  </span>
                </button>
              </div>
            </div>
          </div>

          {/* Active Operators Matrix */}
          <div className="mc-bevel bg-[#1f2020] p-3 sm:p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between pb-2 border-b-2 border-[#0e0e0e]">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-[#dfc740]">security</span>
                <span className="font-silk text-xs sm:text-sm font-bold text-[#dfc740]">
                  ACTIVE OPERATORS MATRIX // permissions.json
                </span>
              </div>
              <span className="font-vt text-sm text-[#97d85d]">CLEARANCE: L4_XUID</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {operators.slice(0, 2).map((op) => (
                <div
                  key={op.xuid}
                  className="mc-inset bg-[#0e0e0e] p-2 flex items-center justify-between gap-2 border-l-2 border-[#97d85d]"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-9 h-9 bg-[#2a2a2a] mc-bevel overflow-hidden shrink-0">
                      <img
                        src={ASSETS.ALEX_SKIN}
                        alt="Skin"
                        className="w-full h-full object-cover"
                      />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1 font-silk text-xs text-white font-bold">
                        <span className="truncate">{op.name}</span>
                        <span className="bg-[#97d85d] text-[#1b3700] font-pixel text-[7px] px-1">
                          OP
                        </span>
                      </div>
                      <div className="font-vt text-xs text-[#dfc740] select-all font-mono truncate">
                        {op.xuid}
                      </div>
                      <div className="font-vt text-[10px] text-[#c2c9b5]">LEVEL 4 // FULL CLEARANCE</div>
                    </div>
                  </div>
                  {!op.isHost && (
                    <button
                      type="button"
                      onClick={() => removeOperator(op.xuid)}
                      className="mc-stone-btn bg-[#1f2020] p-1 text-[#c2c9b5] hover:text-[#ff8782]"
                    >
                      <span className="material-symbols-outlined text-sm">close</span>
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1 font-vt text-sm">
              <span className="text-[#c2c9b5]">REGISTERED OPS: {operators.length}/8</span>
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  placeholder="16-digit XUID..."
                  value={newXuid}
                  onChange={(e) => setNewXuid(e.target.value)}
                  className="bg-[#0e0e0e] mc-inset px-2 py-1 font-mono text-xs text-[#dfc740] outline-none w-36"
                />
                <button
                  type="button"
                  onClick={handleEnrollXuid}
                  className="mc-stone-btn bg-[#2a2a2a] px-3 py-1 font-silk text-[9px] text-[#e4e2e2] hover:text-[#dfc740]"
                >
                  + ENROLL
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN: Command Block Terminal & Real-Time Feed */}
        <div className="lg:col-span-3 flex flex-col gap-4">
          {/* Command Block Terminal Frame */}
          <div className="mc-bevel bg-[#1f2020] p-3 flex flex-col gap-2 relative">
            <div className="flex items-center justify-between pb-2 border-b-2 border-[#0e0e0e]">
              <div className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 bg-[#97d85d] animate-ping mc-bevel" />
                <span className="font-silk text-xs font-bold text-[#97d85d]">
                  COMMAND BLOCK TERMINAL
                </span>
              </div>
              <button
                type="button"
                onClick={clearLogs}
                className="mc-stone-btn bg-[#0e0e0e] px-1.5 py-0.5 font-vt text-xs text-[#c2c9b5]"
              >
                [FLUSH]
              </button>
            </div>

            <div className="font-vt text-xs text-[#c2c9b5] flex justify-between">
              <span>STDOUT STREAM: BDS-DAEMON</span>
              <span className="text-[#dfc740]">SOCKET: 19132</span>
            </div>

            {/* Terminal Screen */}
            <div className="w-full h-72 bg-[#0e0e0e] mc-inset p-2 overflow-y-auto flex flex-col gap-1 font-vt text-base leading-tight select-text">
              {logs.map((l) => (
                <div key={l.id} className="text-[#c2c9b5]">
                  <span className="text-[#8c9380]">[{l.timestamp}] </span>
                  <span className="text-[#dfc740] font-bold">[{l.tag}] </span>
                  <span>{l.message}</span>
                </div>
              ))}
            </div>

            {/* Macros */}
            <div className="flex flex-wrap gap-1 pt-1 font-vt text-sm">
              <motion.button
                type="button"
                whileTap={{ scale: 0.94 }}
                onClick={() => executeCommand('/list')}
                className="mc-stone-btn bg-[#0e0e0e] px-2 py-0.5 text-[#dfc740] cursor-pointer"
              >
                /list
              </motion.button>
              <motion.button
                type="button"
                whileTap={{ scale: 0.94 }}
                onClick={() => executeCommand('/time set day')}
                className="mc-stone-btn bg-[#0e0e0e] px-2 py-0.5 text-[#97d85d] cursor-pointer"
              >
                /day
              </motion.button>
              <motion.button
                type="button"
                whileTap={{ scale: 0.94 }}
                onClick={() => executeCommand('/weather clear')}
                className="mc-stone-btn bg-[#0e0e0e] px-2 py-0.5 text-[#c2c9b5] cursor-pointer"
              >
                /clear
              </motion.button>
              <motion.button
                type="button"
                whileTap={{ scale: 0.94 }}
                onClick={() => executeCommand('/say [BROADCAST] Maintenance in 10m')}
                className="mc-stone-btn bg-[#0e0e0e] px-2 py-0.5 text-[#ff8782] cursor-pointer"
              >
                /broadcast
              </motion.button>
            </div>

            {/* Prompt Input */}
            <div className="flex items-center gap-1.5 mt-1 font-vt">
              <div className="mc-inset bg-[#0e0e0e] px-2 py-1 flex-1 flex items-center gap-1">
                <span className="text-xl text-[#97d85d] font-bold select-none">/</span>
                <input
                  type="text"
                  value={cmdInput}
                  onChange={(e) => setCmdInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleExec()}
                  placeholder="command (say, op, gamemode)..."
                  className="w-full bg-transparent text-lg text-[#e4e2e2] outline-none"
                />
              </div>
              <motion.button
                type="button"
                whileTap={{ scale: 0.92 }}
                onClick={handleExec}
                className="mc-bevel-green bg-[#97d85d] px-3 py-1 font-silk text-xs text-[#1b3700] font-bold cursor-pointer"
              >
                EXEC
              </motion.button>
            </div>
          </div>

          {/* Tactical Death & Combat Live Feed */}
          <div className="mc-inset bg-[#0e0e0e] p-3 flex flex-col gap-2">
            <div className="flex items-center justify-between border-b border-[#343535] pb-1.5">
              <span className="font-silk text-[9px] text-[#ff8782] font-bold flex items-center gap-1">
                <span className="material-symbols-outlined text-xs">skull</span>
                DEATH LOGS & COMBAT FEED
              </span>
              <span className="font-pixel text-[8px] text-[#97d85d]">LIVE</span>
            </div>
            <div className="font-vt text-sm flex flex-col gap-1.5 text-[#c2c9b5]">
              <div className="flex items-start gap-1.5">
                <span className="text-[#ff8782] font-bold">[DEAD]</span>
                <span>
                  Player <strong className="text-white">SteveBuilder</strong> was blown up by Creeper in Sector C4
                </span>
              </div>
              <div className="flex items-start gap-1.5">
                <span className="text-[#97d85d] font-bold">[JOIN]</span>
                <span>
                  Player <strong className="text-[#97d85d]">EnderNinja</strong> connected to realm
                </span>
              </div>
              <div className="flex items-start gap-1.5">
                <span className="text-[#dfc740] font-bold">[LEVEL]</span>
                <span>
                  Player <strong className="text-[#dfc740]">AlexMiner</strong> unlocked advancement [Monster Hunter]
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
