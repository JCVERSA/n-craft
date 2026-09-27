import { useState } from 'react';
import { motion } from 'motion/react';
import { useServer } from '../context/ServerContext.tsx';
import { ASSETS } from '../types/server.ts';
import { playClickSound, playErrorSound, playXpSound } from '../utils/audio.ts';

export function F3TelemetryView() {
  const {
    telemetry,
    operators,
    addOperator,
    demoteOperator,
    banUser,
    executeCommand,
    hotReloadDeploy,
    stopServer,
    logs,
    clearLogs,
  } = useServer();

  const [terminalInput, setTerminalInput] = useState('');
  const [newXuid, setNewXuid] = useState('');
  const [frameCounter, setFrameCounter] = useState(189204);
  const [isPollingF3, setIsPollingF3] = useState(false);

  const handleSendTerminal = () => {
    if (!terminalInput.trim()) return;
    executeCommand(terminalInput);
    setTerminalInput('');
  };

  const handleAppendOperator = () => {
    if (!newXuid.trim()) return;
    if (!/^\d{16}$/.test(newXuid.trim())) {
      alert('Bedrock Error: Operator registration requires a valid 16-digit numeric Xbox XUID.');
      return;
    }
    addOperator('Agent_' + newXuid.slice(-4), newXuid.trim(), 4);
    setNewXuid('');
  };

  const handlePollF3 = () => {
    playClickSound();
    setIsPollingF3(true);
    setFrameCounter((prev) => prev + Math.floor(Math.random() * 50 + 10));
    setTimeout(() => {
      setIsPollingF3(false);
      playXpSound();
    }, 400);
  };

  return (
    <div className="w-full max-w-[1920px] mx-auto p-2 sm:p-3 flex flex-col gap-2 font-space pb-28 select-none">
      {/* Flight Sub-Header */}
      <div className="w-full bg-[#0e0e0e] border border-[#2a2a2a] p-2 flex flex-wrap items-center justify-between gap-3 text-xs font-jb">
        <div className="flex items-center gap-2">
          <span className="px-2 py-0.5 bg-[#1f2020] mc-inset text-[#dfc740] font-bold">
            &lt;SERVER_BDS&gt; v1.21.30.03
          </span>
          <span className="text-[#c2c9b5] hidden sm:inline">
            DAEMON: <strong className="text-[#97d85d]">BDS-DAEMON // x86_64 LINUX VPS</strong>
          </span>
          <span className="text-[#8c9380]">|</span>
          <span className="text-[#c2c9b5]">
            PROTOCOL: <strong className="text-[#dfc740]">671</strong>
          </span>
        </div>

        <div className="flex items-center gap-3">
          <div className="hidden md:flex items-center gap-2 text-[#c2c9b5]">
            <span className="material-symbols-outlined text-[14px] text-[#97d85d]">hub</span>
            <span>PLAYIT: <strong className="text-[#dfc740] select-all font-mono">{ASSETS.SERVER_IP}</strong></span>
            <span className="text-[#97d85d] font-bold">{telemetry.pingMs}ms [RTT]</span>
          </div>

          <button
            type="button"
            onClick={handlePollF3}
            className="mc-stone-btn bg-[#2a2a2a] px-2 py-0.5 text-xs text-[#e4e2e2] hover:text-[#dfc740] flex items-center gap-1"
          >
            <span className={`material-symbols-outlined text-sm ${isPollingF3 ? 'animate-spin' : ''}`}>
              refresh
            </span>
            <span>POLL_F3</span>
          </button>

          <button
            type="button"
            onClick={() => {
              if (confirm('EMERGENCY SIGKILL BDS: Force terminate Bedrock Dedicated Server daemon immediately?')) {
                stopServer();
              }
            }}
            className="mc-bevel bg-[#93000a] text-[#ffdad6] px-2 py-0.5 font-bold hover:bg-[#ff5555] hover:text-black flex items-center gap-1"
          >
            <span className="material-symbols-outlined text-sm">dangerous</span>
            <span>[SIGKILL]</span>
          </button>
        </div>
      </div>

      {/* Main 3-Column Mission Control Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-2 items-start">
        {/* COLUMN 1: F3 Debug Overlay & Telemetry Stack (3 cols) */}
        <div className="lg:col-span-4 xl:col-span-3 flex flex-col gap-2">
          {/* F3 Root Frame */}
          <div className="bg-[#0e0e0e] mc-inset p-2.5 flex flex-col gap-2">
            <div className="flex items-center justify-between border-b border-[#2a2a2a] pb-1.5 font-jb">
              <div className="flex items-center gap-1.5">
                <span className="text-[#dfc740] font-bold text-xs">[F3] TELEMETRY OVERLAY</span>
                <span className="bg-[#97d85d] text-[#1b3700] font-bold text-[9px] px-1 mc-bevel">
                  LIVE_FEED
                </span>
              </div>
              <span className="text-[10px] text-[#8c9380]">FRAME #{frameCounter}</span>
            </div>

            {/* Raw F3 Minecraft Debug Stream */}
            <div className="bg-[#1b1c1c] p-2 mc-inset font-jb text-[11px] leading-relaxed flex flex-col gap-1 text-[#c2c9b5] select-text">
              <div className="text-[#dfc740] font-bold">Minecraft Bedrock BDS 1.21.30.03 (Vanilla / Server)</div>
              <div>CPU: 4x AMD EPYC 7763 64-Core Processor @ 2.44GHz</div>
              <div>
                MEM: <span className="text-[#97d85d] font-bold">6240MB / 8192MB</span> [78%] Allocated
              </div>
              <div>THREAD POOL: <span className="text-[#97d85d] font-bold">8/8 WORKERS</span> (IO: 2, Chunks: 4, Net: 2)</div>
              <div>
                ENTITIES: <span className="text-[#dfc740] font-bold">142</span> (Loaded Chunks: 256) | Tick: 50.00ms
              </div>
              <div>BEDROCK PROTOCOL: 671 | Compression: Snappy (Level 7)</div>
              <div>
                CHUNK_CACHE: <span className="text-[#97d85d] font-bold">HIT RATE 99.4%</span> (Disk I/O 1.2 MB/s)
              </div>
              <div>COORDINATES: Spawn [X: 120, Y: 72, Z: -34] | Dimension: Overworld</div>
            </div>

            {/* Realtime Memory Allocation Matrix Bar */}
            <div className="flex flex-col gap-1 pt-1 font-jb">
              <div className="flex justify-between text-[11px]">
                <span className="text-[#c2c9b5]">HEAP ALLOCATION:</span>
                <span className="text-[#dfc740] font-bold">6,240 MB / 8,192 MB (76.1%)</span>
              </div>
              <div className="h-3.5 bg-[#0e0e0e] mc-inset flex overflow-hidden p-0.5 gap-0.5">
                <div className="h-full bg-[#97d85d] w-[48%]" title="Dedicated World Chunks (3,932 MB)" />
                <div className="h-full bg-[#dfc740] w-[22%]" title="Entity & Physics State (1,802 MB)" />
                <div className="h-full bg-[#ff8782] w-[8%]" title="Behavior Scripts VM (506 MB)" />
                <div className="h-full bg-[#343535] flex-1" title="Unallocated Free Buffer" />
              </div>
              <div className="flex justify-between text-[8px] text-[#8c9380]">
                <span>[■ CHUNKS 48%]</span>
                <span>[■ ENTITY 22%]</span>
                <span>[■ SCRIPT 8%]</span>
                <span>[FREE 22%]</span>
              </div>
            </div>

            {/* 20 TPS Timeline (24 tick bars) */}
            <div className="flex flex-col gap-1 pt-1 font-jb">
              <div className="flex justify-between items-center text-[11px]">
                <span className="text-[#c2c9b5]">TICK RATE TIMELINE:</span>
                <span className="text-[#97d85d] font-bold">20.00 TPS (AVG 14.2ms / tick)</span>
              </div>
              <div className="h-12 bg-[#1b1c1c] mc-inset p-1.5 flex items-end justify-between gap-1">
                {[32, 30, 34, 28, 31, 33, 55, 32, 30, 29, 35, 31, 30, 32, 48, 31, 29, 33, 30, 31, 32, 29, 34, 31].map(
                  (h, i) => (
                    <div
                      key={i}
                      className={`w-1.5 ${h > 40 ? 'bg-[#dfc740]' : 'bg-[#97d85d]'}`}
                      style={{ height: `${h}%` }}
                      title={`${(h * 0.45).toFixed(1)}ms`}
                    />
                  )
                )}
              </div>
              <div className="flex justify-between text-[8px] text-[#8c9380]">
                <span>0.0ms (IDEAL)</span>
                <span className="text-[#dfc740] font-bold">50.0ms LIMIT (20 TPS)</span>
                <span className="text-[#ff8782]">100ms LAG SPIKE</span>
              </div>
            </div>

            {/* Chunk & Packet Pipeline */}
            <div className="grid grid-cols-2 gap-1 pt-1 font-jb">
              <div className="bg-[#1b1c1c] p-1.5 mc-inset flex flex-col">
                <span className="text-[9px] text-[#8c9380] uppercase">SUB-CHUNK GENERATOR</span>
                <span className="font-bold text-[#97d85d] text-xs">2,048 /s</span>
                <span className="text-[8px] text-[#dfc740]">LevelDB Async Ok</span>
              </div>
              <div className="bg-[#1b1c1c] p-1.5 mc-inset flex flex-col">
                <span className="text-[9px] text-[#8c9380] uppercase">PACKET PIPELINE</span>
                <span className="font-bold text-[#dfc740] text-xs">1.82k PKT/s</span>
                <span className="text-[8px] text-[#97d85d]">RakNet UDP Steady</span>
              </div>
            </div>
          </div>

          {/* Beacon Emitter Harness */}
          <div className="bg-[#0e0e0e] mc-bevel p-2 flex flex-col gap-1.5">
            <div className="flex items-center justify-between border-b border-[#2a2a2a] pb-1 font-jb">
              <div className="flex items-center gap-1.5">
                <span className="material-symbols-outlined text-[15px] text-[#dfc740]">lightbulb</span>
                <span className="font-bold text-[#dfc740] text-xs">BEACON EMITTER HARNESS</span>
              </div>
              <span className="text-[#97d85d] text-[10px] font-bold">[LEVEL 4 PYRAMID]</span>
            </div>
            <div className="flex items-center gap-2.5">
              <div className="w-16 h-16 bg-[#1b1c1c] mc-inset p-0.5 shrink-0 flex items-center justify-center relative overflow-hidden">
                <img
                  src={ASSETS.BEACON_LOGO}
                  alt="Beacon"
                  className="w-full h-full object-cover"
                />
              </div>
              <div className="flex-1 flex flex-col gap-0.5 font-jb text-[10px]">
                <div className="flex justify-between">
                  <span className="text-[#8c9380]">BEAM FREQ:</span>
                  <span className="text-[#dfc740] font-bold">482.1 THz [HASTE II]</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#8c9380]">RADIUS BUFF:</span>
                  <span className="text-[#97d85d] font-bold">50 BLOCKS ACTIVE</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#8c9380]">MINERAL CORE:</span>
                  <span className="text-white">164 NETHERITE BLOCKS</span>
                </div>
                <div className="h-1.5 bg-[#1f2020] mc-inset w-full overflow-hidden mt-0.5">
                  <div className="h-full bg-[#97d85d] w-[94%]" />
                </div>
              </div>
            </div>
          </div>

            {/* Quick Hardware Signals Keypad */}
            <div className="bg-[#1b1c1c] mc-inset p-2 flex flex-col gap-1 font-jb">
              <div className="text-[9px] text-[#8c9380] uppercase tracking-wider">HARDWARE SIGNALS:</div>
              <div className="grid grid-cols-2 gap-1 text-[11px]">
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.94 }}
                  onClick={() => executeCommand('/save-all')}
                  className="mc-stone-btn bg-[#2a2a2a] py-1 px-1.5 text-white hover:text-[#dfc740] flex items-center justify-center gap-1 cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[13px]">save</span>
                  <span>FLUSH CHUNKS</span>
                </motion.button>
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.94 }}
                  onClick={() => executeCommand('/tps')}
                  className="mc-stone-btn bg-[#2a2a2a] py-1 px-1.5 text-white hover:text-[#dfc740] flex items-center justify-center gap-1 cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[13px]">speed</span>
                  <span>POLL TICK</span>
                </motion.button>
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.94 }}
                  onClick={() => executeCommand('/whitelist reload')}
                  className="mc-stone-btn bg-[#2a2a2a] py-1 px-1.5 text-white hover:text-[#97d85d] flex items-center justify-center gap-1 cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[13px]">shield</span>
                  <span>SYNC WL</span>
                </motion.button>
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.94 }}
                  onClick={() => executeCommand('/kill @e[type=item]')}
                  className="mc-stone-btn bg-[#2a2a2a] py-1 px-1.5 text-white hover:text-[#ff8782] flex items-center justify-center gap-1 cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[13px]">cleaning_services</span>
                  <span>CLEAR DROPS</span>
                </motion.button>
              </div>
            </div>
        </div>

        {/* COLUMN 2: Deployment Sequencer & XUID Matrix (5 cols) */}
        <div className="lg:col-span-5 xl:col-span-5 flex flex-col gap-2">
          {/* Top Deck: Sequencer */}
          <div className="bg-[#0e0e0e] mc-inset p-2.5 flex flex-col gap-2">
            <div className="flex items-center justify-between border-b border-[#2a2a2a] pb-1.5 font-jb">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-[#dfc740] text-[17px]">alt_route</span>
                <span className="font-bold text-[#dfc740] text-xs">DEPLOYMENT SEQUENCER</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-[#8c9380]">
                  PIPELINE: <strong className="text-[#97d85d]">BDS-BEDROCK-PULL</strong>
                </span>
                <button
                  type="button"
                  onClick={hotReloadDeploy}
                  className="mc-bevel bg-[#a99300] px-2 py-0.5 text-[#393000] font-bold text-[10px] hover:bg-[#dfc740] flex items-center gap-1"
                >
                  <span className="material-symbols-outlined text-[12px]">bolt</span>
                  <span>HOT RELOAD</span>
                </button>
              </div>
            </div>

            {/* Target Release & Checksum */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 bg-[#1b1c1c] p-2 mc-inset font-jb text-[10px]">
              <div>
                <span className="text-[#8c9380] uppercase block">TARGET RELEASE BDS</span>
                <div className="bg-[#0e0e0e] mc-inset px-2 py-1 text-[#dfc740] font-bold mt-0.5 truncate">
                  v1.21.30.03 (Bedrock Dedicated Server)
                </div>
              </div>
              <div>
                <span className="text-[#8c9380] uppercase block">SHA-256 CHECKSUM VERIFIER</span>
                <div className="bg-[#0e0e0e] mc-inset px-2 py-1 flex items-center justify-between mt-0.5">
                  <span className="text-[#c2c9b5] font-mono">e3b0c442...8b4c79</span>
                  <span className="text-[#97d85d] font-bold">[VERIFIED]</span>
                </div>
              </div>
            </div>

            {/* Hex Steps (0x01 .. 0x06) */}
            <div className="flex flex-col gap-1 font-jb">
              <div className="flex justify-between items-center text-[10px]">
                <span className="text-[#8c9380]">SEQUENCER STEP: [0x03 OF 0x06]</span>
                <span className="text-[#dfc740] font-bold">78% INGESTION RATE</span>
              </div>
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-1 text-[10px]">
                <div className="bg-[#1b1c1c] mc-inset p-1 flex flex-col text-center">
                  <span className="text-[#97d85d] font-bold">0x01 PASS</span>
                  <span className="text-white text-[9px]">SIGTERM</span>
                  <span className="text-[8px] text-[#8c9380]">clean_halt</span>
                </div>
                <div className="bg-[#1b1c1c] mc-inset p-1 flex flex-col text-center">
                  <span className="text-[#97d85d] font-bold">0x02 PASS</span>
                  <span className="text-white text-[9px]">PURGE</span>
                  <span className="text-[8px] text-[#8c9380]">.lock flush</span>
                </div>
                <div className="bg-[#2a2a2a] mc-bevel-green p-1 flex flex-col text-center animate-pulse">
                  <span className="text-[#97d85d] font-bold">0x03 RUN</span>
                  <span className="text-[#dfc740] text-[9px] font-bold">DOWNLOAD</span>
                  <span className="text-[8px] text-[#97d85d]">64/82 MB</span>
                </div>
                <div className="bg-[#1b1c1c] mc-inset p-1 flex flex-col text-center opacity-70">
                  <span className="text-[#8c9380]">0x04 WAIT</span>
                  <span className="text-white text-[9px]">UNZIP</span>
                  <span className="text-[8px] text-[#8c9380]">pack_inject</span>
                </div>
                <div className="bg-[#1b1c1c] mc-inset p-1 flex flex-col text-center opacity-70">
                  <span className="text-[#8c9380]">0x05 WAIT</span>
                  <span className="text-white text-[9px]">CONFIG</span>
                  <span className="text-[8px] text-[#8c9380]">props_sync</span>
                </div>
                <div className="bg-[#1b1c1c] mc-inset p-1 flex flex-col text-center opacity-70">
                  <span className="text-[#8c9380]">0x06 WAIT</span>
                  <span className="text-white text-[9px]">LAUNCH</span>
                  <span className="text-[8px] text-[#8c9380]">bds_daemon</span>
                </div>
              </div>
              <div className="h-2 bg-[#1b1c1c] mc-inset flex overflow-hidden mt-0.5">
                <div className="h-full bg-[#97d85d] w-[33.3%]" />
                <div className="h-full bg-[#97d85d] w-[33.3%]" />
                <div className="h-full bg-[#dfc740] w-[12%] animate-pulse" />
                <div className="h-full bg-[#343535] flex-1" />
              </div>
            </div>
          </div>

          {/* Bottom Deck: XUID Authorization Matrix */}
          <div className="bg-[#0e0e0e] mc-inset p-2.5 flex-1 flex flex-col gap-2 font-jb">
            <div className="flex items-center justify-between border-b border-[#2a2a2a] pb-1.5">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-[#dfc740] text-[17px]">verified_user</span>
                <span className="font-bold text-[#dfc740] text-xs">XUID AUTHORIZATION MATRIX</span>
              </div>
              <span className="text-[10px] text-[#8c9380]">
                FILE: <span className="text-[#dfc740] select-all font-mono">permissions.json</span>
              </span>
            </div>

            {/* AlexMiner Personnel Card */}
            <div className="bg-[#1b1c1c] mc-bevel p-2 flex items-center gap-2.5">
              <div className="w-12 h-12 bg-[#0e0e0e] mc-inset p-0.5 shrink-0 overflow-hidden relative">
                <img
                  src={ASSETS.ALEX_SKIN}
                  alt="Avatar"
                  className="w-full h-full object-cover"
                />
                <div className="absolute top-0 right-0 bg-[#97d85d] text-[#1b3700] text-[7px] font-bold px-1">
                  OP4
                </div>
              </div>
              <div className="flex-1 min-w-0 font-jb">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="font-bold text-[#dfc740] text-xs">Alex_Miner</span>
                    <span className="bg-[#97d85d] text-[#1b3700] font-bold text-[8px] px-1 mc-bevel">
                      ROOT CLEARANCE
                    </span>
                  </div>
                  <span className="text-[9px] text-[#97d85d] font-bold font-mono">BADGE #001</span>
                </div>
                <div className="text-[9px] text-[#8c9380] flex items-center gap-1 mt-0.5">
                  <span>XBOX XUID:</span>
                  <span className="text-white font-bold select-all font-mono">2535412894129841</span>
                </div>
                <div className="text-[8px] text-[#8c9380] truncate font-mono">
                  SIGNATURE: 0x9F3B...D41A [ECDSA-SECP256R1]
                </div>
              </div>
            </div>

            {/* Active Operators Table */}
            <div className="flex flex-col gap-1 max-h-52 overflow-y-auto pr-0.5">
              {operators.map((op) => (
                <div
                  key={op.xuid}
                  className="bg-[#1b1c1c] mc-inset p-1.5 flex items-center justify-between gap-2 text-xs"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <div
                      className={`w-6 h-6 mc-bevel flex items-center justify-center font-bold text-[9px] ${
                        op.level === 4
                          ? 'bg-[#97d85d] text-[#1b3700]'
                          : 'bg-[#dfc740] text-[#393000]'
                      }`}
                    >
                      {op.level === 4 ? 'OP' : 'MOD'}
                    </div>
                    <div className="min-w-0">
                      <div className="font-bold text-white truncate">{op.name}</div>
                      <div className="text-[8px] text-[#8c9380] font-mono select-all truncate">
                        XUID: {op.xuid}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-[8px] text-[#dfc740] bg-[#0e0e0e] px-1.5 py-0.5 mc-inset font-bold">
                      LEVEL {op.level}
                    </span>
                    {!op.isHost && (
                      <button
                        type="button"
                        onClick={() => demoteOperator(op.xuid)}
                        className="mc-stone-btn bg-[#2a2a2a] p-1 text-[#c2c9b5] hover:text-[#ff8782]"
                        title="Demote Operator"
                      >
                        <span className="material-symbols-outlined text-sm">gavel</span>
                      </button>
                    )}
                  </div>
                </div>
              ))}

              {/* Sample flagged user */}
              <div className="bg-[#93000a]/30 mc-inset p-1.5 flex items-center justify-between gap-2 text-xs border-t border-l border-[#ff8782]">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-6 h-6 bg-[#ff8782] text-black font-bold text-[9px] flex items-center justify-center mc-bevel">
                    !
                  </div>
                  <div className="min-w-0">
                    <div className="font-bold text-[#ff8782] truncate">Unauthorized_User_88</div>
                    <div className="text-[8px] text-[#ffdad6] font-mono select-all truncate">
                      UNKNOWN XUID: 0000000000000000
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => banUser('Unauthorized_User_88')}
                  className="mc-bevel bg-[#93000a] text-[#ffdad6] px-2 py-0.5 font-bold text-[8px] hover:bg-[#ff5555] hover:text-black flex items-center gap-0.5"
                >
                  <span className="material-symbols-outlined text-xs">block</span>
                  <span>BAN</span>
                </button>
              </div>
            </div>

            {/* Add Operator By 16-Digit XUID */}
            <div className="bg-[#1b1c1c] p-2 mc-inset flex flex-col gap-1">
              <div className="text-[9px] text-[#8c9380] uppercase flex justify-between">
                <span>REGISTER NEW OPERATOR BY 16-DIGIT XUID:</span>
                <span className="text-[#dfc740] font-bold">[MAX 8 OPERATORS]</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="mc-inset bg-[#0e0e0e] p-1 flex-1 flex items-center gap-1">
                  <span className="text-[#dfc740] font-mono text-xs">#</span>
                  <input
                    type="text"
                    value={newXuid}
                    onChange={(e) => setNewXuid(e.target.value)}
                    placeholder="e.g. 2535499120485721"
                    className="w-full bg-transparent text-xs text-white outline-none font-mono"
                  />
                </div>
                <button
                  type="button"
                  onClick={handleAppendOperator}
                  className="mc-stone-btn bg-[#2a2a2a] px-3 py-1 text-white hover:text-[#dfc740] font-bold text-xs flex items-center gap-1"
                >
                  <span className="material-symbols-outlined text-sm">add</span>
                  <span>APPEND</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* COLUMN 3: CRT Phosphor Terminal & Macro Pad (4 cols) */}
        <div className="lg:col-span-3 xl:col-span-4 flex flex-col gap-2">
          {/* CRT Screen Terminal */}
          <div className="crt-screen mc-inset p-3 flex-1 flex flex-col justify-between overflow-hidden relative min-h-[460px]">
            <div className="flex items-center justify-between border-b border-[#343535]/60 pb-1.5 z-30 shrink-0 font-jb">
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 bg-[#97d85d] rounded-full animate-ping" />
                <span className="font-bold text-xs text-[#97d85d] crt-glow">BDS TTY // STDOUT</span>
              </div>
              <div className="flex items-center gap-1 text-[10px]">
                <span className="text-[#8c9380]">[BAUD: 115200]</span>
                <button type="button" onClick={clearLogs} className="text-[#dfc740] hover:underline px-1">
                  [CLS]
                </button>
              </div>
            </div>

            {/* CRT Terminal Log Stream */}
            <div className="flex-1 overflow-y-auto py-2 flex flex-col gap-1 font-jb text-xs leading-relaxed z-30 select-text pr-1 max-h-[360px]">
              {logs.map((l) => (
                <div key={l.id} className="text-[#c2c9b5] font-mono">
                  <span className="text-[#8c9380]">[{l.timestamp}] </span>
                  <span
                    className={`font-bold ${
                      l.level === 'error'
                        ? 'text-[#ff8782] crt-glow-red'
                        : l.level === 'warn'
                        ? 'text-[#dfc740] crt-glow-gold'
                        : 'text-[#97d85d] crt-glow'
                    }`}
                  >
                    [{l.tag}]
                  </span>{' '}
                  <span className={l.level === 'exec' ? 'text-[#dfc740] crt-glow-gold' : ''}>
                    {l.message}
                  </span>
                </div>
              ))}
            </div>

            {/* CRT Input Line */}
            <div className="pt-2 border-t border-[#343535]/60 z-30 shrink-0 flex items-center gap-1.5 font-jb">
              <span className="text-[#97d85d] font-bold text-sm crt-glow">&gt;</span>
              <input
                type="text"
                value={terminalInput}
                onChange={(e) => setTerminalInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSendTerminal()}
                placeholder="Type BDS command (say, op, kick, gamerule)..."
                className="w-full bg-transparent font-mono text-xs text-[#97d85d] crt-glow outline-none placeholder:text-[#8c9380]/40"
              />
              <button
                type="button"
                onClick={handleSendTerminal}
                className="mc-bevel bg-[#97d85d] text-[#1b3700] font-bold px-2.5 py-0.5 text-xs hover:bg-[#b2f575]"
              >
                RUN
              </button>
            </div>
          </div>

          {/* Broadcast Macro Pad */}
          <div className="bg-[#0e0e0e] mc-inset p-2 flex flex-col gap-1 font-jb">
            <div className="flex items-center justify-between text-[10px] text-[#8c9380]">
              <span className="uppercase flex items-center gap-1">
                <span className="material-symbols-outlined text-[13px] text-[#dfc740]">grid_view</span>
                SERVER BROADCAST MACRO PAD
              </span>
              <span className="text-[#97d85d] font-bold">[1-CLICK EXEC]</span>
            </div>
            <div className="grid grid-cols-2 gap-1 text-[10px]">
              <button
                type="button"
                onClick={() => executeCommand('/say [ANNOUNCEMENT] Server restart in 10 minutes!')}
                className="mc-stone-btn bg-[#1f2020] py-1 px-1.5 text-white hover:text-[#dfc740] flex items-center justify-between"
              >
                <span>[BROADCAST 10M]</span>
                <span className="material-symbols-outlined text-[12px]">campaign</span>
              </button>
              <button
                type="button"
                onClick={() => executeCommand('/time set day')}
                className="mc-stone-btn bg-[#1f2020] py-1 px-1.5 text-white hover:text-[#dfc740] flex items-center justify-between"
              >
                <span>[/TIME SET DAY]</span>
                <span className="material-symbols-outlined text-[12px]">wb_sunny</span>
              </button>
              <button
                type="button"
                onClick={() => executeCommand('/weather clear')}
                className="mc-stone-btn bg-[#1f2020] py-1 px-1.5 text-white hover:text-[#dfc740] flex items-center justify-between"
              >
                <span>[/WEATHER CLEAR]</span>
                <span className="material-symbols-outlined text-[12px]">clear_day</span>
              </button>
              <button
                type="button"
                onClick={() => executeCommand('/gamerule keepInventory true')}
                className="mc-stone-btn bg-[#1f2020] py-1 px-1.5 text-white hover:text-[#97d85d] flex items-center justify-between"
              >
                <span>[KEEP_INV TRUE]</span>
                <span className="material-symbols-outlined text-[12px]">inventory_2</span>
              </button>
              <button
                type="button"
                onClick={() => executeCommand('/difficulty normal')}
                className="mc-stone-btn bg-[#1f2020] py-1 px-1.5 text-white hover:text-[#97d85d] flex items-center justify-between"
              >
                <span>[DIFF: NORMAL]</span>
                <span className="material-symbols-outlined text-[12px]">shield</span>
              </button>
              <button
                type="button"
                onClick={() => executeCommand('/kick @a[name=!AlexMiner] [MAINTENANCE]')}
                className="mc-stone-btn bg-[#1f2020] py-1 px-1.5 text-white hover:text-[#ff8782] flex items-center justify-between"
              >
                <span>[KICK ALL GUESTS]</span>
                <span className="material-symbols-outlined text-[12px]">logout</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
