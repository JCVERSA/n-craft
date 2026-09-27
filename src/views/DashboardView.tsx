import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useServer } from '../context/ServerContext.tsx';
import { TerminalLogs } from '../components/TerminalLogs.tsx';
import { GameMode, Difficulty, ASSETS } from '../types/server.ts';

export function DashboardView() {
  const {
    serverStatus,
    telemetry,
    properties,
    updateProperties,
    operators,
    addOperator,
    removeOperator,
    pipelineStep,
    isSimulatingCrash,
    setSimulateCrash,
    hotReloadDeploy,
    restartServer,
    stopServer,
    copyIp,
    copiedNotice,
    formatUptime,
  } = useServer();

  const [newXuid, setNewXuid] = useState('');
  const [newOpName, setNewOpName] = useState('');
  const [showAddOpModal, setShowAddOpModal] = useState(false);
  const [validationErr, setValidationErr] = useState<string | null>(null);

  const handleAddOp = () => {
    if (!newXuid.trim()) return;
    const ok = addOperator(newOpName.trim() || 'Operator', newXuid.trim(), 4);
    if (ok) {
      setNewXuid('');
      setNewOpName('');
      setShowAddOpModal(false);
      setValidationErr(null);
    } else {
      setValidationErr('Invalid XUID format — numeric 16-digit Xbox ID required.');
    }
  };

  const handleAdjustPlayers = (delta: number) => {
    const next = Math.max(2, Math.min(100, properties.maxPlayers + delta));
    updateProperties({ maxPlayers: next });
  };

  return (
    <div className="flex flex-col lg:flex-row w-full gap-4 pb-24">
      {/* Left Sidebar: Quick Controls & Mini Engine Status */}
      <aside className="w-full lg:w-64 bg-[#1b1c1c] border-2 border-[#0e0e0e] p-3 flex flex-col gap-3 shrink-0 mc-inset">
        {/* Engine Status Mini Card */}
        <div className="mc-inset bg-[#0e0e0e] p-2.5">
          <div className="font-jb text-[10px] text-[#c2c9b5] mb-1 flex justify-between">
            <span>ENGINE STATUS</span>
            <span className="text-[#97d85d] font-bold">v1.21.30</span>
          </div>
          <div className="h-2 bg-[#1f2020] w-full mc-inset mb-1 overflow-hidden">
            <motion.div
              className={`h-full ${
                serverStatus === 'RUNNING' ? 'bg-[#97d85d]' : 'bg-[#dfc740]'
              }`}
              initial={{ width: 0 }}
              animate={{ width: `${Math.round((telemetry.ramUsedMb / telemetry.ramTotalMb) * 100)}%` }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            />
          </div>
          <div className="flex justify-between font-jb text-[10px]">
            <span className="text-[#c2c9b5]">
              RAM {(telemetry.ramUsedMb / 1024).toFixed(1)}/8.0 GB
            </span>
            <span className="text-[#dfc740] font-bold">
              {Math.round((telemetry.ramUsedMb / telemetry.ramTotalMb) * 100)}%
            </span>
          </div>
        </div>

        {/* Quick Nav Controls */}
        <div className="font-pixel text-[9px] text-[#c2c9b5] uppercase tracking-wider px-1">
          Quick Controls
        </div>
        <div className="flex flex-col gap-1 font-jb text-xs">
          <div className="flex items-center px-2 py-1.5 mc-stone-btn bg-[#1f2020] text-[#97d85d] font-bold">
            <span>Terminal & Metrics</span>
          </div>
          <motion.button
            type="button"
            whileTap={{ scale: 0.96 }}
            onClick={() => updateProperties({ motd: 'Nebula SMP - Active Seed ' + properties.seed.slice(0, 4) })}
            className="flex items-center px-2 py-1.5 text-[#c2c9b5] hover:text-[#e4e2e2] hover:bg-[#1f2020] mc-stone-btn text-left"
          >
            <span>Level Data & Saves</span>
          </motion.button>
          <motion.button
            type="button"
            whileTap={{ scale: 0.96 }}
            onClick={() => setShowAddOpModal(true)}
            className="flex items-center px-2 py-1.5 text-[#c2c9b5] hover:text-[#e4e2e2] hover:bg-[#1f2020] mc-stone-btn text-left"
          >
            <span>Permissions & Bans</span>
          </motion.button>
          <motion.button
            type="button"
            whileTap={{ scale: 0.96 }}
            onClick={() => updateProperties({ viewDistance: properties.viewDistance === 16 ? 24 : 16 })}
            className="flex items-center px-2 py-1.5 text-[#c2c9b5] hover:text-[#e4e2e2] hover:bg-[#1f2020] mc-stone-btn text-left"
          >
            <span>Behavior / Resource</span>
          </motion.button>
          <motion.button
            type="button"
            whileTap={{ scale: 0.96 }}
            onClick={() => updateProperties({ allowCheats: !properties.allowCheats })}
            className="flex items-center px-2 py-1.5 text-[#c2c9b5] hover:text-[#e4e2e2] hover:bg-[#1f2020] mc-stone-btn text-left"
          >
            <span>server.properties</span>
          </motion.button>
        </div>

        {/* Uptime Box */}
        <div className="mc-inset bg-[#0e0e0e] p-2 mt-auto">
          <div className="font-jb text-[9px] text-[#c2c9b5]">UPTIME</div>
          <div className="font-jb text-xs text-[#97d85d] font-bold font-mono">
            {formatUptime(telemetry.uptimeSeconds)}
          </div>
        </div>
      </aside>

      {/* Main Center Console Column */}
      <main className="flex-1 flex flex-col gap-4 min-w-0">
        {/* 1. STATUS BAR (Minecraft HUD / Beacon Aesthetic) */}
        <div className="w-full bg-[#0e0e0e] mc-inset p-3 sm:p-4 flex flex-col xl:flex-row items-stretch xl:items-center justify-between gap-3">
          {/* Left: Server IP Signpost */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="mc-bevel bg-[#1b1c1c] px-3 py-2 flex items-center gap-2 relative">
              <div className="w-2 h-6 bg-[#a99300] mc-bevel self-stretch my-auto" />
              <div className="flex flex-col">
                <span className="font-jb text-[10px] text-[#c2c9b5] uppercase tracking-wider flex items-center gap-1">
                  <span className="material-symbols-outlined text-[13px] text-[#dfc740]">signpost</span>
                  PUBLIC BEDROCK HOST
                </span>
                <span className="font-jb text-xs sm:text-sm text-[#dfc740] select-all font-bold">
                  {ASSETS.SERVER_IP}
                </span>
              </div>
              <motion.button
                type="button"
                whileTap={{ scale: 0.94 }}
                onClick={copyIp}
                className="mc-stone-btn bg-[#1f2020] px-2 py-1 font-jb text-[10px] text-[#e4e2e2] hover:text-[#dfc740] ml-2 uppercase"
              >
                {copiedNotice ? '[COPIED!]' : '[COPY IP]'}
              </motion.button>
            </div>


            {/* Beacon Aura & Server State */}
            <div className="flex items-center gap-2.5 px-3 py-1.5 bg-[#1f2020] mc-inset">
              <div className="relative flex items-center justify-center">
                <div className="w-3.5 h-3.5 bg-[#97d85d] mc-bevel animate-ping absolute opacity-50" />
                <div className="w-3.5 h-3.5 bg-[#97d85d] mc-bevel relative z-10 flex items-center justify-center">
                  <span className="material-symbols-outlined text-[#1b3700] text-[10px] font-bold">bolt</span>
                </div>
              </div>
              <div>
                <div className="flex items-center gap-1.5">
                  <span className="font-pixel text-xs text-[#97d85d] tracking-wide">
                    {serverStatus}
                  </span>
                  <span className="bg-[#7cbb43] text-[#1b3700] px-1 font-pixel text-[8px] uppercase">
                    STABLE
                  </span>
                </div>
                <span className="font-jb text-[10px] text-[#c2c9b5] flex items-center gap-1">
                  <span className="material-symbols-outlined text-[12px] text-[#97d85d]">schedule</span>
                  UPTIME 3d 14h 22m
                </span>
              </div>
            </div>
          </div>

          {/* Center: Minecraft Telemetry Badges */}
          <div className="grid grid-cols-3 gap-1 flex-1 max-w-lg bg-[#1b1c1c] p-1 mc-inset">
            <div className="bg-[#0e0e0e] p-1.5 text-center mc-inset flex flex-col justify-center">
              <div className="font-jb text-[9px] text-[#c2c9b5]">TICK RATE</div>
              <div className="font-jb text-xs text-[#97d85d] font-bold">20.0 TPS</div>
              <div className="h-1 bg-[#343535] w-full mt-1">
                <div className="h-full bg-[#97d85d] w-full" />
              </div>
            </div>
            <div className="bg-[#0e0e0e] p-1.5 text-center mc-inset flex flex-col justify-center">
              <div className="font-jb text-[9px] text-[#c2c9b5]">DEDICATED RAM</div>
              <div className="font-jb text-xs text-[#dfc740] font-bold">
                {(telemetry.ramUsedMb / 1024).toFixed(1)} / 8.0 GB
              </div>
              <div className="h-1 bg-[#343535] w-full mt-1">
                <div className="h-full bg-[#dfc740] w-[47%]" />
              </div>
            </div>
            <div className="bg-[#0e0e0e] p-1.5 text-center mc-inset flex flex-col justify-center">
              <div className="font-jb text-[9px] text-[#c2c9b5]">CPU LOAD</div>
              <div className="font-jb text-xs text-[#97d85d] font-bold">
                {telemetry.cpuPercent}% AVG
              </div>
              <div className="h-1 bg-[#343535] w-full mt-1">
                <div className="h-full bg-[#97d85d]" style={{ width: `${telemetry.cpuPercent}%` }} />
              </div>
            </div>
          </div>

          {/* Right: Mechanical Actions */}
          <div className="flex items-center gap-2 justify-end">
            <button
              type="button"
              onClick={restartServer}
              className="mc-stone-btn bg-[#2a2a2a] px-3 py-2 font-jb text-xs text-[#e4e2e2] hover:bg-[#343535] flex items-center gap-1.5"
            >
              <span className="material-symbols-outlined text-[16px] text-[#dfc740]">refresh</span>
              <span>RESTART</span>
            </button>
            <button
              type="button"
              onClick={() => {
                if (confirm('Stop the Dedicated Bedrock server? All players will be disconnected.')) {
                  stopServer();
                }
              }}
              className="mc-bevel bg-[#93000a] px-3 py-2 font-jb text-xs text-[#ffdad6] hover:bg-[#ff5555] hover:text-black flex items-center gap-1.5"
            >
              <span className="material-symbols-outlined text-[16px]">power_settings_new</span>
              <span>STOP SERVER</span>
            </button>
          </div>
        </div>

        {/* 2. VERSION & XP DEPLOYMENT PIPELINE */}
        <div className="w-full bg-[#1f2020] mc-bevel p-3 sm:p-4 flex flex-col gap-3">
          <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-3 pb-2 border-b-2 border-[#0e0e0e]">
            <div className="flex flex-wrap items-center gap-3">
              <div>
                <span className="font-jb text-[10px] text-[#c2c9b5] block uppercase">
                  BDS ENGINE VERSION
                </span>
                <div className="mc-inset bg-[#0e0e0e] px-3 py-1 flex items-center gap-2 mt-1">
                  <span className="material-symbols-outlined text-[#dfc740] text-[16px]">dns</span>
                  <select
                    value={properties.engineVersion}
                    onChange={(e) => updateProperties({ engineVersion: e.target.value })}
                    className="bg-transparent font-jb text-xs text-[#dfc740] outline-none cursor-pointer"
                  >
                    <option className="bg-[#0e0e0e] text-[#dfc740]">v1.21.30 (Latest Stable - Bedrock)</option>
                    <option className="bg-[#0e0e0e] text-[#e4e2e2]">v1.21.20 (Bedrock Dedicated)</option>
                    <option className="bg-[#0e0e0e] text-[#e4e2e2]">v1.21.0 (Tricky Trials Update)</option>
                    <option className="bg-[#0e0e0e] text-[#e4e2e2]">v1.20.81 (Rollback LTS)</option>
                  </select>
                </div>
              </div>

              {/* Simulation Crash Checkbox */}
              <div className="pt-4">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={isSimulatingCrash}
                    onChange={(e) => setSimulateCrash(e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-4 h-4 bg-[#0e0e0e] mc-inset flex items-center justify-center peer-checked:bg-[#93000a]">
                    {isSimulatingCrash && (
                      <span className="material-symbols-outlined text-[12px] text-[#ff8782]">close</span>
                    )}
                  </div>
                  <span className="font-jb text-[11px] text-[#c2c9b5] hover:text-[#ff8782]">
                    Simulate Checksum Crash
                  </span>
                </label>
              </div>
            </div>

            {/* Gold XP Enchanted Deploy Button */}
            <button
              type="button"
              onClick={hotReloadDeploy}
              className="mc-bevel bg-[#a99300] px-4 py-2 flex items-center gap-3 hover:bg-[#dfc740] group active:translate-y-0.5"
            >
              <div className="flex flex-col text-left">
                <span className="font-jb text-[9px] text-[#393000] uppercase font-bold tracking-wider">
                  HOT RELOAD ENGINE
                </span>
                <span className="font-pixel text-xs text-[#393000] font-bold flex items-center gap-1">
                  <span>DEPLOY & SYNC</span>
                  <span className="material-symbols-outlined text-[16px] group-hover:rotate-45 transition-transform">
                    bolt
                  </span>
                </span>
              </div>
              <div className="w-8 h-8 bg-[#0e0e0e] mc-inset flex items-center justify-center">
                <span className="font-pixel text-xs text-[#97d85d] font-bold">30</span>
              </div>
            </button>
          </div>

          {/* Multi-stage XP Tracker Progress Bar */}
          <div className="flex flex-col gap-1.5">
            <div className="flex justify-between font-jb text-[10px] text-[#c2c9b5]">
              <span className="flex items-center gap-1 text-[#97d85d]">
                <span className="material-symbols-outlined text-[13px]">sync</span>
                PIPELINE ACTIVE: BDS-BEDROCK-PULL
              </span>
              <span className="text-[#dfc740] font-bold">
                STEP {pipelineStep} OF 6 (78% INGESTION)
              </span>
            </div>

            {/* Segmented Level Bar Matrix */}
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-1.5">
              {/* Step 1 */}
              <div className="mc-inset bg-[#0e0e0e] p-1.5 flex items-center gap-1.5">
                <span className="w-4 h-4 bg-[#97d85d] text-[#1b3700] font-bold text-[10px] flex items-center justify-center mc-bevel">
                  ✓
                </span>
                <div className="min-w-0">
                  <div className="font-jb text-[10px] text-[#97d85d] truncate font-bold">1. STOP</div>
                  <div className="font-space text-[9px] text-[#c2c9b5] truncate">Clean SIGTERM</div>
                </div>
              </div>

              {/* Step 2 */}
              <div className="mc-inset bg-[#0e0e0e] p-1.5 flex items-center gap-1.5">
                <span className="w-4 h-4 bg-[#97d85d] text-[#1b3700] font-bold text-[10px] flex items-center justify-center mc-bevel">
                  ✓
                </span>
                <div className="min-w-0">
                  <div className="font-jb text-[10px] text-[#97d85d] truncate font-bold">2. CACHE</div>
                  <div className="font-space text-[9px] text-[#c2c9b5] truncate">Purged .lock</div>
                </div>
              </div>

              {/* Step 3 */}
              <div
                className={`p-1.5 flex items-center gap-1.5 border-l-2 border-[#97d85d] ${
                  isSimulatingCrash ? 'bg-[#93000a]' : 'bg-[#2a2a2a] mc-bevel'
                }`}
              >
                <div className="w-4 h-4 bg-[#7cbb43] text-[#1b3700] font-bold text-[8px] flex items-center justify-center animate-pulse mc-inset">
                  78%
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-jb text-[10px] text-[#97d85d] font-bold truncate">3. DOWNLOAD</div>
                  <div className="font-space text-[9px] text-[#dfc740] truncate">64/82 MB BDS</div>
                </div>
              </div>

              {/* Step 4 */}
              <div
                className={`p-1.5 flex items-center gap-1.5 ${
                  isSimulatingCrash
                    ? 'mc-bevel bg-[#93000a] border-l-2 border-[#ff8782]'
                    : 'mc-inset bg-[#0e0e0e] opacity-60'
                }`}
              >
                <div className="w-4 h-4 bg-[#1f2020] text-[#c2c9b5] font-bold text-[10px] flex items-center justify-center mc-bevel">
                  {isSimulatingCrash ? '!' : '4'}
                </div>
                <div className="min-w-0">
                  <div className="font-jb text-[10px] text-[#e4e2e2] truncate font-bold">
                    {isSimulatingCrash ? 'CHECKSUM FAIL' : 'EXTRACT'}
                  </div>
                  <div className="font-space text-[9px] text-[#c2c9b5] truncate">behavior_pack</div>
                </div>
              </div>

              {/* Step 5 */}
              <div className="mc-inset bg-[#0e0e0e] p-1.5 flex items-center gap-1.5 opacity-60">
                <div className="w-4 h-4 bg-[#1f2020] text-[#c2c9b5] font-bold text-[10px] flex items-center justify-center mc-bevel">
                  5
                </div>
                <div className="min-w-0">
                  <div className="font-jb text-[10px] text-[#e4e2e2] truncate">CONFIG</div>
                  <div className="font-space text-[9px] text-[#c2c9b5] truncate">server.props</div>
                </div>
              </div>

              {/* Step 6 */}
              <div className="mc-inset bg-[#0e0e0e] p-1.5 flex items-center gap-1.5 opacity-60">
                <div className="w-4 h-4 bg-[#1f2020] text-[#c2c9b5] font-bold text-[10px] flex items-center justify-center mc-bevel">
                  6
                </div>
                <div className="min-w-0">
                  <div className="font-jb text-[10px] text-[#e4e2e2] truncate">START</div>
                  <div className="font-space text-[9px] text-[#c2c9b5] truncate">Boot Dedicated</div>
                </div>
              </div>
            </div>

            {/* Error Banner when crash simulated */}
            {isSimulatingCrash && (
              <div className="mc-inset bg-[#93000a] p-3 mt-1 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="p-1 bg-[#0e0e0e] mc-bevel text-[#ff8782] flex items-center justify-center">
                    <span className="material-symbols-outlined text-[22px]">skull</span>
                  </div>
                  <div>
                    <div className="font-pixel text-[10px] text-[#ffdad6] uppercase font-bold tracking-wider">
                      [CRITICAL ERROR] STEP 4 CRASHED: YOU DIED
                    </div>
                    <p className="font-jb text-xs text-[#ffdad6] mt-0.5">
                      checksum mismatch on behavior_pack_v2.zip — sha256 failed validation.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSimulateCrash(false)}
                  className="mc-stone-btn bg-[#0e0e0e] px-3 py-1 font-jb text-[11px] text-[#ff8782] hover:bg-[#ff5555] hover:text-black whitespace-nowrap"
                >
                  [RETRY WITH CLEAN CACHE]
                </button>
              </div>
            )}
          </div>
        </div>

        {/* 3. SERVER CONFIG & ADMIN PERMISSIONS ROW */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
          {/* 3A. Bedrock Properties Form */}
          <div className="lg:col-span-8 bg-[#1f2020] mc-bevel p-3 sm:p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between pb-2 border-b-2 border-[#0e0e0e]">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 bg-[#0e0e0e] mc-inset flex items-center justify-center">
                  <span className="material-symbols-outlined text-[#dfc740] text-[18px]">tune</span>
                </div>
                <div>
                  <h2 className="font-pixel text-xs sm:text-sm text-[#dfc740]">BEDROCK PROPERTIES</h2>
                  <span className="font-jb text-[10px] text-[#c2c9b5]">
                    Active Configuration: server.properties
                  </span>
                </div>
              </div>
              <span className="font-pixel text-[9px] text-[#97d85d] mc-inset bg-[#0e0e0e] px-2 py-1">
                SYNC STATE: CLEAN
              </span>
            </div>

            {/* MOTD & Level Name */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label className="font-jb text-[10px] text-[#e4e2e2] flex items-center gap-1 uppercase">
                  <span>SERVER MOTD NAME</span>
                  <span className="text-[#dfc740] font-bold">*</span>
                </label>
                <div className="mc-inset bg-[#0e0e0e] p-1.5 flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[#c2c9b5] text-[15px]">edit_note</span>
                  <input
                    type="text"
                    value={properties.motd}
                    onChange={(e) => updateProperties({ motd: e.target.value })}
                    className="bg-transparent font-jb text-xs text-[#e4e2e2] w-full outline-none focus:text-[#dfc740]"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <label className="font-jb text-[10px] text-[#e4e2e2] flex items-center gap-1 uppercase">
                  <span>ACTIVE LEVEL WORLD</span>
                  <span className="text-[#dfc740] font-bold">*</span>
                </label>
                <div className="mc-inset bg-[#0e0e0e] p-1.5 flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[#97d85d] text-[15px]">public</span>
                  <input
                    type="text"
                    value={properties.levelName}
                    onChange={(e) => updateProperties({ levelName: e.target.value })}
                    className="bg-transparent font-jb text-xs text-[#e4e2e2] w-full outline-none focus:text-[#97d85d]"
                  />
                </div>
              </div>
            </div>

            {/* Game Mode Selector */}
            <div className="flex flex-col gap-1">
              <label className="font-jb text-[10px] text-[#e4e2e2] uppercase flex items-center gap-1">
                <span>DEFAULT GAME MODE</span>
                <span className="text-[#dfc740] font-bold">*</span>
              </label>
              <div className="grid grid-cols-3 gap-1.5">
                {(['SURVIVAL', 'CREATIVE', 'ADVENTURE'] as GameMode[]).map((mode) => {
                  const isActive = properties.gamemode === mode;
                  return (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => updateProperties({ gamemode: mode })}
                      className={`p-2 flex items-center justify-center gap-1.5 font-jb text-xs font-bold transition-none ${
                        isActive
                          ? 'mc-bevel bg-[#343535] text-[#dfc740] border-t-2 border-l-2 border-[#dfc740]'
                          : 'mc-stone-btn bg-[#1f2020] text-[#c2c9b5] hover:text-[#e4e2e2]'
                      }`}
                    >
                      <span className="material-symbols-outlined text-[16px]">
                        {mode === 'SURVIVAL'
                          ? 'sports_martial_arts'
                          : mode === 'CREATIVE'
                          ? 'nature'
                          : 'explore'}
                      </span>
                      <span>{mode}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Difficulty Selector */}
            <div className="flex flex-col gap-1">
              <label className="font-jb text-[10px] text-[#e4e2e2] uppercase flex items-center gap-1">
                <span>WORLD DIFFICULTY LEVEL</span>
                <span className="text-[#dfc740] font-bold">*</span>
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                {(['PEACEFUL', 'EASY', 'NORMAL', 'HARD'] as Difficulty[]).map((diff) => {
                  const isActive = properties.difficulty === diff;
                  return (
                    <button
                      key={diff}
                      type="button"
                      onClick={() => updateProperties({ difficulty: diff })}
                      className={`p-1.5 text-center font-jb text-[11px] font-bold ${
                        isActive
                          ? 'mc-bevel bg-[#343535] text-[#97d85d] border-t-2 border-l-2 border-[#97d85d]'
                          : diff === 'HARD'
                          ? 'mc-stone-btn bg-[#1f2020] text-[#ff8782] hover:text-white'
                          : 'mc-stone-btn bg-[#1f2020] text-[#c2c9b5] hover:text-white'
                      }`}
                    >
                      {diff} {isActive && '[ACTIVE]'}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Max Players Stepper */}
            <div className="flex items-center justify-between bg-[#0e0e0e] p-2.5 mc-inset">
              <div>
                <span className="font-jb text-xs text-[#e4e2e2] block uppercase font-bold">
                  MAX CONCURRENT PLAYERS
                </span>
                <span className="font-space text-[10px] text-[#c2c9b5]">
                  Recommended: 10-30 for BDS VPS instances
                </span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => handleAdjustPlayers(-1)}
                  className="mc-stone-btn bg-[#1f2020] w-7 h-7 flex items-center justify-center font-pixel text-xs text-[#e4e2e2] active:translate-y-0.5"
                >
                  -
                </button>
                <div className="w-12 h-7 bg-[#2a2a2a] mc-inset flex items-center justify-center font-pixel text-xs text-[#dfc740]">
                  {properties.maxPlayers}
                </div>
                <button
                  type="button"
                  onClick={() => handleAdjustPlayers(1)}
                  className="mc-stone-btn bg-[#1f2020] w-7 h-7 flex items-center justify-center font-pixel text-xs text-[#e4e2e2] active:translate-y-0.5"
                >
                  +
                </button>
              </div>
            </div>

            {/* Collapsible Advanced World Settings */}
            <details className="group bg-[#0e0e0e] mc-inset">
              <summary className="p-2.5 cursor-pointer select-none font-jb text-xs text-[#dfc740] flex items-center justify-between hover:bg-[#1b1c1c]">
                <div className="flex items-center gap-1.5 font-bold">
                  <span className="material-symbols-outlined text-[17px]">settings_suggest</span>
                  <span>ADVANCED WORLD SETTINGS & REDSTONE RULES</span>
                </div>
                <span className="material-symbols-outlined transition-transform group-open:rotate-180 text-sm">
                  expand_more
                </span>
              </summary>
              <div className="p-3 border-t-2 border-[#343535] flex flex-col gap-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1">
                    <span className="font-jb text-[10px] text-[#c2c9b5] uppercase">
                      WORLD GENERATION SEED
                    </span>
                    <div className="mc-inset bg-[#2a2a2a] p-1.5">
                      <input
                        type="text"
                        value={properties.seed}
                        onChange={(e) => updateProperties({ seed: e.target.value })}
                        className="bg-transparent font-jb text-xs text-[#e4e2e2] w-full outline-none"
                      />
                    </div>
                  </div>

                  <div className="flex flex-col gap-1">
                    <span className="font-jb text-[10px] text-[#c2c9b5] uppercase">
                      TICK DISTANCE (CHUNKS)
                    </span>
                    <div className="mc-inset bg-[#2a2a2a] p-1.5 flex justify-between items-center font-jb text-xs">
                      <span>4 Chunks (Bedrock Default)</span>
                      <span className="text-[#dfc740] font-bold">[OPTIMAL]</span>
                    </div>
                  </div>
                </div>

                {/* View Distance Slider */}
                <div className="flex flex-col gap-1">
                  <div className="flex justify-between font-jb text-[10px]">
                    <span className="text-[#c2c9b5] uppercase">VIEW DISTANCE CHUNKS</span>
                    <span className="text-[#97d85d] font-bold">{properties.viewDistance} Chunks</span>
                  </div>
                  <input
                    type="range"
                    min="6"
                    max="32"
                    value={properties.viewDistance}
                    onChange={(e) => updateProperties({ viewDistance: parseInt(e.target.value, 10) })}
                    className="w-full accent-[#97d85d] cursor-pointer h-2 bg-[#343535] mc-inset"
                  />
                </div>

                {/* Redstone Cheats Lever */}
                <div className="flex items-center justify-between p-2 bg-[#1f2020] mc-bevel">
                  <div>
                    <div className="font-jb text-xs text-[#e4e2e2] uppercase flex items-center gap-1.5 font-bold">
                      <span className="material-symbols-outlined text-[#ff8782] text-[16px]">offline_bolt</span>
                      <span>ALLOW CHEATS / COMMAND BLOCKS</span>
                    </div>
                    <span className="font-space text-[10px] text-[#c2c9b5]">
                      Enables /give, /gamemode, and behavior scripting hooks
                    </span>
                  </div>

                  {/* Lever Graphic Toggle */}
                  <button
                    type="button"
                    onClick={() => updateProperties({ allowCheats: !properties.allowCheats })}
                    className="flex items-center gap-2 px-3 py-1 bg-[#0e0e0e] mc-inset"
                  >
                    <span
                      className={`font-jb text-[10px] font-bold ${
                        properties.allowCheats ? 'text-[#97d85d]' : 'text-[#c2c9b5]'
                      }`}
                    >
                      {properties.allowCheats ? 'POWER: ON' : 'POWER: OFF'}
                    </span>
                    <div className="w-3.5 h-5 bg-[#93000a] mc-bevel flex items-start justify-center p-0.5">
                      <div
                        className={`w-2 h-2.5 bg-[#dfc740] mc-bevel transition-transform ${
                          properties.allowCheats ? 'translate-y-0' : 'translate-y-2'
                        }`}
                      />
                    </div>
                  </button>
                </div>
              </div>
            </details>
          </div>

          {/* 3B. Admin & Operators Panel */}
          <div className="lg:col-span-4 bg-[#1f2020] mc-bevel p-3 sm:p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between pb-2 border-b-2 border-[#0e0e0e]">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 bg-[#0e0e0e] mc-inset flex items-center justify-center">
                  <span className="material-symbols-outlined text-[#dfc740] text-[18px]">shield_person</span>
                </div>
                <div>
                  <h2 className="font-pixel text-xs sm:text-sm text-[#dfc740]">OPERATORS</h2>
                  <span className="font-jb text-[10px] text-[#c2c9b5]">permissions.json (Level 4 OP)</span>
                </div>
              </div>
            </div>

            {/* Helper Info */}
            <div className="mc-inset bg-[#0e0e0e] p-2 flex items-start gap-2">
              <span className="material-symbols-outlined text-[#dfc740] text-[18px] shrink-0">menu_book</span>
              <p className="font-jb text-[10px] text-[#c2c9b5] leading-tight">
                Enter numeric <strong className="text-white">Xbox XUID</strong> (e.g.{' '}
                <span className="text-[#dfc740] select-all">25354...</span>), NOT the gamertag.
              </p>
            </div>

            {/* Operators List */}
            <div className="flex flex-col gap-1.5">
              {operators.map((op) => (
                <div
                  key={op.xuid}
                  className="mc-inset bg-[#0e0e0e] p-2 flex items-center justify-between font-jb"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-5 h-5 bg-[#97d85d] mc-bevel flex items-center justify-center text-[#1b3700] font-bold text-[9px]">
                      OP
                    </div>
                    <div className="min-w-0">
                      <div className="text-xs text-[#e4e2e2] font-bold truncate">{op.name}</div>
                      <div className="text-[9px] text-[#c2c9b5] select-all font-mono">{op.xuid}</div>
                    </div>
                  </div>
                  {!op.isHost && (
                    <button
                      type="button"
                      onClick={() => removeOperator(op.xuid)}
                      className="mc-stone-btn bg-[#1f2020] p-1 text-[#c2c9b5] hover:text-[#ff8782]"
                      title="Remove Operator"
                    >
                      <span className="material-symbols-outlined text-[15px]">delete</span>
                    </button>
                  )}
                </div>
              ))}

              {/* Sample validation error indicator */}
              <div className="mc-inset bg-[#93000a]/40 p-2 flex flex-col gap-1 border border-[#ff8782]">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 font-jb text-xs text-[#ffdad6] font-bold">
                    <span className="w-4 h-4 bg-[#0e0e0e] mc-inset text-[#ff8782] flex items-center justify-center text-[10px]">
                      !
                    </span>
                    <span>NotAnXUID_99</span>
                  </div>
                  <span className="font-jb text-[9px] text-[#ff8782]">[FORMAT_ERR]</span>
                </div>
                <span className="font-jb text-[10px] text-[#ffdad6] flex items-center gap-1">
                  <span className="material-symbols-outlined text-[12px]">warning</span>
                  Invalid format — numeric 16-digit Xbox ID required.
                </span>
              </div>
            </div>

            {/* Add Operator Dialog Box */}
            {showAddOpModal ? (
              <div className="mc-inset bg-[#0e0e0e] p-2.5 flex flex-col gap-2 border border-[#dfc740]">
                <span className="font-pixel text-[9px] text-[#dfc740]">ENSCRIBE NEW OPERATOR</span>
                <input
                  type="text"
                  placeholder="Gamertag (e.g. PixelHero)"
                  value={newOpName}
                  onChange={(e) => setNewOpName(e.target.value)}
                  className="bg-[#1f2020] mc-inset p-1.5 font-jb text-xs text-white outline-none"
                />
                <input
                  type="text"
                  placeholder="16-digit XUID (e.g. 2535499120485721)"
                  value={newXuid}
                  onChange={(e) => setNewXuid(e.target.value)}
                  className="bg-[#1f2020] mc-inset p-1.5 font-jb text-xs text-[#dfc740] font-mono outline-none"
                />
                {validationErr && (
                  <span className="font-jb text-[10px] text-[#ff8782]">{validationErr}</span>
                )}
                <div className="flex items-center gap-2 mt-1">
                  <button
                    type="button"
                    onClick={handleAddOp}
                    className="mc-bevel bg-[#97d85d] px-3 py-1 font-pixel text-[9px] text-[#1b3700] font-bold flex-1"
                  >
                    ADD (LEVEL 4)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddOpModal(false);
                      setValidationErr(null);
                    }}
                    className="mc-stone-btn bg-[#2a2a2a] px-3 py-1 font-jb text-xs text-[#c2c9b5]"
                  >
                    CANCEL
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowAddOpModal(true)}
                className="mc-stone-btn bg-[#2a2a2a] py-2 px-3 font-jb text-xs text-[#e4e2e2] hover:text-[#dfc740] flex items-center justify-center gap-1.5"
              >
                <span className="material-symbols-outlined text-[16px]">add_box</span>
                <span>ADD OPERATOR (MAX 8)</span>
              </button>
            )}

            {/* Whitelist Status */}
            <div className="mc-inset bg-[#0e0e0e] p-2 flex justify-between items-center mt-auto font-jb text-xs">
              <span className="text-[#c2c9b5]">WHITELIST ENFORCEMENT</span>
              <span
                className={`font-bold ${
                  properties.whitelistEnforced ? 'text-[#97d85d]' : 'text-[#ff8782]'
                }`}
              >
                {properties.whitelistEnforced ? '[ON - ENFORCED]' : '[OFF - PUBLIC]'}
              </span>
            </div>
          </div>
        </div>

        {/* 4. Bedrock Dedicated Logs & Interactive Terminal */}
        <TerminalLogs title="BEDROCK DEDICATED LOGS" heightClass="h-56" />
      </main>
    </div>
  );
}
