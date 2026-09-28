import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useServer } from '../context/ServerContext.tsx';
import { useDialogs } from '../components/DialogProvider.tsx';
import { ASSETS } from '../types/server.ts';
import { playClickSound, playAnvilSound } from '../utils/audio.ts';

export function ChestMatrixView() {
  const {
    properties,
    updateProperties,
    telemetry,
    operators,
    addOperator,
    removeOperator,
    restartServer,
    hotReloadDeploy,
    isSimulatingCrash,
    setSimulateCrash,
    chatDrawerOpen,
    setChatDrawerOpen,
    logs,
    executeCommand,
  } = useServer();

  const dialogs = useDialogs();
  const [drawerInput, setDrawerInput] = useState('');
  const [newXuid, setNewXuid] = useState('');
  const [activeSlot, setActiveSlot] = useState<number | null>(6);

  const handleDrawerSend = () => {
    if (!drawerInput.trim()) return;
    executeCommand(drawerInput);
    setDrawerInput('');
  };

  const handleAddOp = async () => {
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
    addOperator('Enscribed_OP', newXuid.trim(), 4);
    setNewXuid('');
  };

  const adjustSlots = (delta: number) => {
    updateProperties({ maxPlayers: Math.max(2, Math.min(100, properties.maxPlayers + delta)) });
  };

  return (
    <div className="w-full max-w-7xl mx-auto px-2 sm:px-4 py-4 flex flex-col gap-6 pb-28 select-none">
      {/* 1. MASTER 54-SLOT DOUBLE CHEST INTERFACE */}
      <section className="mc-gui-window p-3 sm:p-4 text-[#373737]">
        {/* Chest Header */}
        <div className="flex items-center justify-between pb-2 mb-2 border-b-2 border-[#8b8b8b]">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[#373737] text-[22px]">inventory_2</span>
            <h2 className="text-[#2b2b2b] font-pixel text-xs sm:text-sm font-bold tracking-wider">
              CHEST: BEDROCK SERVER CORE MATRIX (54 SLOTS)
            </h2>
          </div>
          <div className="flex items-center gap-3">
            <motion.button
              type="button"
              whileTap={{ scale: 0.94 }}
              onClick={() => {
                playClickSound();
                setChatDrawerOpen((prev) => !prev);
              }}
              className="mc-btn px-2.5 py-1 text-[10px] font-pixel bg-[#2a2a2a] text-white flex items-center gap-1.5 cursor-pointer"
            >
              <span className="material-symbols-outlined text-[14px] text-[#97d85d]">chat</span>
              <span>{chatDrawerOpen ? 'CLOSE LOGS [T]' : 'CHAT & LOGS [T]'}</span>
            </motion.button>
            <span className="font-pixel text-[10px] text-[#555] hidden md:inline">
              HOVER SLOTS FOR DIEGETIC LORE
            </span>
          </div>
        </div>

        {/* 6 x 9 Grid (54 Slots) */}
        <div className="grid grid-cols-6 sm:grid-cols-9 gap-1.5 sm:gap-2 p-2 bg-[#c6c6c6] mc-gui-inner">
          {/* Slot 01: TPS Clock */}
          <div
            onClick={() => {
              playClickSound();
              setActiveSlot(1);
            }}
            className={`mc-slot h-14 sm:h-16 flex flex-col items-center justify-center cursor-pointer group ${
              activeSlot === 1 ? 'mc-slot-active' : ''
            }`}
          >
            <span className="material-symbols-outlined text-[#7cbb43] text-2xl group-hover:scale-110 transition-transform">
              schedule
            </span>
            <span className="text-[9px] font-pixel text-white pixel-shadow font-bold mt-[-2px]">
              20.0
            </span>
            <div className="hidden group-hover:block absolute bottom-[calc(100%+8px)] left-1/2 -translate-x-1/2 bg-[#110e1a] border-2 border-[#2b1154] p-2 z-50 whitespace-nowrap shadow-xl pointer-events-none">
              <div className="text-[#FFE55C] font-pixel text-xs">Clock of Steady Ticks</div>
              <div className="text-[#a0a0a0] font-jb text-[11px]">Tick Rate: 20.0 TPS (Stable)</div>
              <div className="text-[#7cbb43] font-jb text-[10px]">Zero chunk lag detected</div>
              <div className="text-[#888] font-pixel text-[9px] mt-1">Lore: Forged with gold gears & redstone dust</div>
            </div>
          </div>

          {/* Slot 02: Enchanted BDS Engine Core */}
          <div
            onClick={() => {
              playClickSound();
              setActiveSlot(2);
            }}
            className={`mc-slot h-14 sm:h-16 flex flex-col items-center justify-center cursor-pointer group bg-[#9d9d9d] ${
              activeSlot === 2 ? 'mc-slot-active' : ''
            }`}
          >
            <span className="material-symbols-outlined text-[#dfc740] text-2xl group-hover:scale-110 transition-transform animate-pulse">
              dns
            </span>
            <span className="text-[9px] font-pixel text-white pixel-shadow font-bold mt-[-2px]">
              v1.21
            </span>
            <div className="hidden group-hover:block absolute bottom-[calc(100%+8px)] left-1/2 -translate-x-1/2 bg-[#110e1a] border-2 border-[#2b1154] p-2 z-50 whitespace-nowrap shadow-xl pointer-events-none">
              <div className="text-[#dfc740] font-pixel text-xs">Enchanted BDS Core v1.21.30</div>
              <div className="text-[#c2c9b5] font-jb text-[11px]">Bedrock Dedicated Engine</div>
              <div className="text-[#7cbb43] font-jb text-[10px]">Durability: 3d 14h / Infinite</div>
              <div className="text-[#dfc740] font-jb text-[10px]">Tricky Trials Protocol Active</div>
            </div>
          </div>

          {/* Slot 03: Souls Counter */}
          <div
            onClick={() => {
              playClickSound();
              setActiveSlot(3);
            }}
            className={`mc-slot h-14 sm:h-16 flex flex-col items-center justify-center cursor-pointer group ${
              activeSlot === 3 ? 'mc-slot-active' : ''
            }`}
          >
            <span className="material-symbols-outlined text-[#7cbb43] text-2xl group-hover:scale-110 transition-transform">
              group
            </span>
            <span className="text-[9px] font-pixel text-[#FFE55C] pixel-shadow font-bold mt-[-2px]">
              {telemetry.playersOnline}/{properties.maxPlayers}
            </span>
            <div className="hidden group-hover:block absolute bottom-[calc(100%+8px)] left-1/2 -translate-x-1/2 bg-[#110e1a] border-2 border-[#2b1154] p-2 z-50 whitespace-nowrap shadow-xl pointer-events-none">
              <div className="text-[#7cbb43] font-pixel text-xs">Vessel of Connected Souls</div>
              <div className="text-white font-jb text-[11px]">
                {telemetry.playersOnline} of {properties.maxPlayers} Players Online
              </div>
              <div className="text-[#c2c9b5] font-jb text-[10px]">Max BDS VPS Cap: {properties.maxPlayers} Slots</div>
            </div>
          </div>

          {/* Slot 04: Glowstone RAM Shard */}
          <div
            onClick={() => {
              playClickSound();
              setActiveSlot(4);
            }}
            className={`mc-slot h-14 sm:h-16 flex flex-col items-center justify-center cursor-pointer group ${
              activeSlot === 4 ? 'mc-slot-active' : ''
            }`}
          >
            <span className="material-symbols-outlined text-[#dfc740] text-2xl group-hover:scale-110 transition-transform">
              memory
            </span>
            <span className="text-[9px] font-pixel text-white pixel-shadow font-bold mt-[-2px]">
              3.8G
            </span>
            <div className="hidden group-hover:block absolute bottom-[calc(100%+8px)] left-1/2 -translate-x-1/2 bg-[#110e1a] border-2 border-[#2b1154] p-2 z-50 whitespace-nowrap shadow-xl pointer-events-none">
              <div className="text-[#FFE55C] font-pixel text-xs">Glowstone RAM Shard</div>
              <div className="text-white font-jb text-[11px]">
                Allocation: {(telemetry.ramUsedMb / 1024).toFixed(1)} / 8.0 GB
              </div>
              <div className="text-[#7cbb43] font-jb text-[10px]">No heap pressure detected</div>
            </div>
          </div>

          {/* Slot 05: CPU Blaze Rod */}
          <div
            onClick={() => {
              playClickSound();
              setActiveSlot(5);
            }}
            className={`mc-slot h-14 sm:h-16 flex flex-col items-center justify-center cursor-pointer group ${
              activeSlot === 5 ? 'mc-slot-active' : ''
            }`}
          >
            <span className="material-symbols-outlined text-[#ff8782] text-2xl group-hover:scale-110 transition-transform">
              local_fire_department
            </span>
            <span className="text-[9px] font-pixel text-white pixel-shadow font-bold mt-[-2px]">
              {telemetry.cpuPercent}%
            </span>
            <div className="hidden group-hover:block absolute bottom-[calc(100%+8px)] left-1/2 -translate-x-1/2 bg-[#110e1a] border-2 border-[#2b1154] p-2 z-50 whitespace-nowrap shadow-xl pointer-events-none">
              <div className="text-[#ff8782] font-pixel text-xs">Blaze Rod Processor</div>
              <div className="text-white font-jb text-[11px]">Server CPU Load: {telemetry.cpuPercent}% AVG</div>
              <div className="text-[#7cbb43] font-jb text-[10px]">Temp: 44°C - Cool</div>
            </div>
          </div>

          {/* Slot 06: Active World Compass */}
          <div
            onClick={() => {
              playClickSound();
              setActiveSlot(6);
            }}
            className={`mc-slot h-14 sm:h-16 flex flex-col items-center justify-center cursor-pointer group mc-slot-active`}
          >
            <span className="material-symbols-outlined text-[#97d85d] text-2xl group-hover:scale-110 transition-transform">
              explore
            </span>
            <span className="text-[8px] font-pixel text-[#dfc740] pixel-shadow font-bold mt-[-2px]">
              WORLD
            </span>
            <div className="hidden group-hover:block absolute bottom-[calc(100%+8px)] left-1/2 -translate-x-1/2 bg-[#110e1a] border-2 border-[#2b1154] p-2 z-50 whitespace-nowrap shadow-xl pointer-events-none">
              <div className="text-[#FFE55C] font-pixel text-xs">Loadout Compass: {properties.levelName}</div>
              <div className="text-white font-jb text-[11px]">Seed: {properties.seed}</div>
              <div className="text-[#7cbb43] font-jb text-[10px]">Level Type: Bedrock Default (Infinite)</div>
            </div>
          </div>

          {/* Slot 07: Nether Dimension */}
          <div
            onClick={() => {
              playClickSound();
              setActiveSlot(7);
            }}
            className="mc-slot h-14 sm:h-16 flex flex-col items-center justify-center cursor-pointer group"
          >
            <span className="material-symbols-outlined text-purple-400 text-2xl group-hover:scale-110 transition-transform">
              cyclone
            </span>
            <span className="text-[8px] font-pixel text-purple-300 pixel-shadow font-bold mt-[-2px]">
              NETHER
            </span>
            <div className="hidden group-hover:block absolute bottom-[calc(100%+8px)] left-1/2 -translate-x-1/2 bg-[#110e1a] border-2 border-[#2b1154] p-2 z-50 whitespace-nowrap shadow-xl pointer-events-none">
              <div className="text-purple-300 font-pixel text-xs">Nether Sub-Server Link</div>
              <div className="text-white font-jb text-[11px]">Dimension ID: 1 (Loaded Chunks: 42)</div>
            </div>
          </div>

          {/* Slot 08: End Dimension */}
          <div
            onClick={() => {
              playClickSound();
              setActiveSlot(8);
            }}
            className="mc-slot h-14 sm:h-16 flex flex-col items-center justify-center cursor-pointer group"
          >
            <span className="material-symbols-outlined text-cyan-400 text-2xl group-hover:scale-110 transition-transform">
              brightness_high
            </span>
            <span className="text-[8px] font-pixel text-cyan-300 pixel-shadow font-bold mt-[-2px]">
              END
            </span>
            <div className="hidden group-hover:block absolute bottom-[calc(100%+8px)] left-1/2 -translate-x-1/2 bg-[#110e1a] border-2 border-[#2b1154] p-2 z-50 whitespace-nowrap shadow-xl pointer-events-none">
              <div className="text-cyan-300 font-pixel text-xs">End Dimension Gate</div>
              <div className="text-white font-jb text-[11px]">Dragon Fight: Ready / Respawnable</div>
            </div>
          </div>

          {/* Slot 09: Totem of Hot Reboot */}
          <div
            onClick={restartServer}
            className="mc-slot h-14 sm:h-16 flex flex-col items-center justify-center cursor-pointer group bg-[#524700]"
          >
            <span className="material-symbols-outlined text-[#dfc740] text-2xl group-hover:rotate-180 transition-transform">
              autorenew
            </span>
            <span className="text-[8px] font-pixel text-[#FFE55C] pixel-shadow font-bold mt-[-2px]">
              REBOOT
            </span>
            <div className="hidden group-hover:block absolute bottom-[calc(100%+8px)] left-1/2 -translate-x-1/2 bg-[#110e1a] border-2 border-[#2b1154] p-2 z-50 whitespace-nowrap shadow-xl pointer-events-none">
              <div className="text-[#FFE55C] font-pixel text-xs">Totem of Hot Reboot</div>
              <div className="text-white font-jb text-[11px]">Action: Clean SIGTERM & Boot BDS</div>
              <div className="text-[#7cbb43] font-jb text-[10px]">Keeps inventory and world locks safe</div>
            </div>
          </div>

          {/* Slot 10: Whitelist Ledger */}
          <div
            onClick={() => updateProperties({ whitelistEnforced: !properties.whitelistEnforced })}
            className="mc-slot h-14 sm:h-16 flex flex-col items-center justify-center cursor-pointer group"
          >
            <span className="material-symbols-outlined text-white text-2xl">book</span>
            <span
              className={`text-[8px] font-pixel pixel-shadow font-bold mt-[-2px] ${
                properties.whitelistEnforced ? 'text-[#97d85d]' : 'text-[#ff8782]'
              }`}
            >
              {properties.whitelistEnforced ? 'ON' : 'OFF'}
            </span>
            <div className="hidden group-hover:block absolute bottom-[calc(100%+8px)] left-1/2 -translate-x-1/2 bg-[#110e1a] border-2 border-[#2b1154] p-2 z-50 whitespace-nowrap shadow-xl pointer-events-none">
              <div className="text-white font-pixel text-xs">Whitelist Ledger</div>
              <div className="text-[#c2c9b5] font-jb text-[11px]">
                Status: {properties.whitelistEnforced ? 'ENFORCED' : 'PUBLIC'}
              </div>
              <div className="text-[#dfc740] font-jb text-[10px]">Click to toggle whitelist.json</div>
            </div>
          </div>

          {/* Slot 11: Cheats Redstone Torch */}
          <div
            onClick={() => updateProperties({ allowCheats: !properties.allowCheats })}
            className="mc-slot h-14 sm:h-16 flex flex-col items-center justify-center cursor-pointer group"
          >
            <span
              className={`material-symbols-outlined text-2xl ${
                properties.allowCheats ? 'text-[#ff8782] animate-pulse' : 'text-[#555]'
              }`}
            >
              offline_bolt
            </span>
            <span
              className={`text-[8px] font-pixel pixel-shadow font-bold mt-[-2px] ${
                properties.allowCheats ? 'text-[#97d85d]' : 'text-[#888]'
              }`}
            >
              {properties.allowCheats ? 'CHEATS:ON' : 'CHEATS:OFF'}
            </span>
            <div className="hidden group-hover:block absolute bottom-[calc(100%+8px)] left-1/2 -translate-x-1/2 bg-[#110e1a] border-2 border-[#2b1154] p-2 z-50 whitespace-nowrap shadow-xl pointer-events-none">
              <div className="text-[#ff8782] font-pixel text-xs">
                Signal: {properties.allowCheats ? 'Strong (15/15)' : 'Inactive (0/15)'}
              </div>
              <div className="text-white font-jb text-[11px]">
                Allow Cheats: {properties.allowCheats ? 'ACTIVE' : 'DISABLED'}
              </div>
            </div>
          </div>

          {/* Slot 12: Difficulty Skull */}
          <div
            onClick={() => {
              const order: ('PEACEFUL' | 'EASY' | 'NORMAL' | 'HARD')[] = [
                'PEACEFUL',
                'EASY',
                'NORMAL',
                'HARD',
              ];
              const next = order[(order.indexOf(properties.difficulty) + 1) % order.length];
              updateProperties({ difficulty: next });
            }}
            className="mc-slot h-14 sm:h-16 flex flex-col items-center justify-center cursor-pointer group"
          >
            <span className="material-symbols-outlined text-yellow-500 text-2xl">swords</span>
            <span className="text-[8px] font-pixel text-white pixel-shadow font-bold mt-[-2px]">
              {properties.difficulty.slice(0, 6)}
            </span>
            <div className="hidden group-hover:block absolute bottom-[calc(100%+8px)] left-1/2 -translate-x-1/2 bg-[#110e1a] border-2 border-[#2b1154] p-2 z-50 whitespace-nowrap shadow-xl pointer-events-none">
              <div className="text-yellow-400 font-pixel text-xs">Difficulty: {properties.difficulty}</div>
              <div className="text-[#c2c9b5] font-jb text-[10px]">Click to cycle difficulty setting</div>
            </div>
          </div>

          {/* Slot 13: View Distance Eye */}
          <div className="mc-slot h-14 sm:h-16 flex flex-col items-center justify-center cursor-pointer group">
            <span className="material-symbols-outlined text-[#97d85d] text-2xl">visibility</span>
            <span className="text-[8px] font-pixel text-white pixel-shadow font-bold mt-[-2px]">
              {properties.viewDistance} CHK
            </span>
            <div className="hidden group-hover:block absolute bottom-[calc(100%+8px)] left-1/2 -translate-x-1/2 bg-[#110e1a] border-2 border-[#2b1154] p-2 z-50 whitespace-nowrap shadow-xl pointer-events-none">
              <div className="text-[#97d85d] font-pixel text-xs">Eye of Render Distance</div>
              <div className="text-white font-jb text-[10px]">{properties.viewDistance} Chunks Render Cap</div>
            </div>
          </div>

          {/* Slot 14: Tick Distance */}
          <div className="mc-slot h-14 sm:h-16 flex flex-col items-center justify-center cursor-pointer group">
            <span className="material-symbols-outlined text-[#dfc740] text-2xl">grain</span>
            <span className="text-[8px] font-pixel text-white pixel-shadow font-bold mt-[-2px]">
              4 TICK
            </span>
            <div className="hidden group-hover:block absolute bottom-[calc(100%+8px)] left-1/2 -translate-x-1/2 bg-[#110e1a] border-2 border-[#2b1154] p-2 z-50 whitespace-nowrap shadow-xl pointer-events-none">
              <div className="text-[#dfc740] font-pixel text-xs">Tick Radius: 4 Chunks</div>
              <div className="text-[#c2c9b5] font-jb text-[10px]">Optimized for mobile BDS clients</div>
            </div>
          </div>

          {/* Slot 15: Behavior Pack */}
          <div className="mc-slot h-14 sm:h-16 flex flex-col items-center justify-center cursor-pointer group">
            <span className="material-symbols-outlined text-emerald-400 text-2xl">widgets</span>
            <span className="text-[8px] font-pixel text-emerald-300 pixel-shadow font-bold mt-[-2px]">
              BP (4)
            </span>
          </div>

          {/* Slot 16: Resource Pack */}
          <div className="mc-slot h-14 sm:h-16 flex flex-col items-center justify-center cursor-pointer group">
            <span className="material-symbols-outlined text-cyan-300 text-2xl">palette</span>
            <span className="text-[8px] font-pixel text-cyan-200 pixel-shadow font-bold mt-[-2px]">
              RP (2)
            </span>
          </div>

          {/* Slot 17: Tunnel Minecart */}
          <div className="mc-slot h-14 sm:h-16 flex flex-col items-center justify-center cursor-pointer group">
            <span className="material-symbols-outlined text-[#dfc740] text-2xl">alt_route</span>
            <span className="text-[8px] font-pixel text-[#FFE55C] pixel-shadow font-bold mt-[-2px]">
              TUNNEL
            </span>
          </div>

          {/* Slot 18: World Backup */}
          <div
            onClick={() => executeCommand('/save-all')}
            className="mc-slot h-14 sm:h-16 flex flex-col items-center justify-center cursor-pointer group"
          >
            <span className="material-symbols-outlined text-amber-300 text-2xl">archive</span>
            <span className="text-[8px] font-pixel text-amber-200 pixel-shadow font-bold mt-[-2px]">
              BACKUP
            </span>
          </div>

          {/* Slot 19: Player Alex Doll */}
          <div className="mc-slot h-14 sm:h-16 flex items-center justify-center cursor-pointer group">
            <img
              src={ASSETS.ALEX_SKIN}
              alt="Alex"
              className="w-8 h-8 rounded-none border border-[#dfc740] object-cover"
            />
            <div className="hidden group-hover:block absolute bottom-[calc(100%+8px)] left-1/2 -translate-x-1/2 bg-[#110e1a] border-2 border-[#2b1154] p-2 z-50 whitespace-nowrap shadow-xl pointer-events-none">
              <div className="text-[#dfc740] font-pixel text-xs">Operator: AlexMiner (Host)</div>
              <div className="text-[#c2c9b5] font-jb text-[10px]">XUID: 2535412894129841</div>
            </div>
          </div>

          {/* Slot 20: Steve OP */}
          <div className="mc-slot h-14 sm:h-16 flex items-center justify-center cursor-pointer">
            <div className="w-8 h-8 bg-[#373737] border border-[#7cbb43] flex items-center justify-center font-pixel text-[9px] text-[#7cbb43]">
              STV
            </div>
          </div>

          {/* Slot 21: Forge Permit */}
          <div className="mc-slot h-14 sm:h-16 flex items-center justify-center cursor-pointer">
            <span className="material-symbols-outlined text-stone-300 text-2xl">handyman</span>
          </div>

          {/* Slots 22 - 53 (Empty authentic slots) */}
          {Array.from({ length: 32 }).map((_, i) => (
            <div key={i} className="mc-slot h-14 sm:h-16" />
          ))}

          {/* Slot 54: Matrix Count Indicator */}
          <div className="mc-slot h-14 sm:h-16 flex items-center justify-center bg-[#2a2a2a] text-[#dfc740]">
            <span className="text-[9px] font-pixel font-bold">54/54</span>
          </div>
        </div>
      </section>

      {/* 2. ANVIL & ENCHANTING TABLE SERVER CONFIGURATION ROW */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* 2A. ANVIL CONFIG FORGE */}
        <div className="lg:col-span-8 mc-gui-window p-3 sm:p-4 text-[#373737] flex flex-col gap-3">
          <div className="flex items-center justify-between pb-2 border-b-2 border-[#8b8b8b]">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[#373737] text-[22px]">hardware</span>
              <h3 className="text-[#2b2b2b] font-pixel text-xs sm:text-sm font-bold tracking-wider">
                ANVIL: REPAIR & FORGE PROPERTIES
              </h3>
            </div>
            {/* Enchant Cost Badge */}
            <div className="flex items-center gap-1.5 bg-[#1b1c1c] px-3 py-1 border-2 border-[#555]">
              <span className="text-[#7cbb43] text-[10px] font-pixel font-bold">ENCHANT COST:</span>
              <div className="text-[#FFE55C] font-pixel text-xs font-bold animate-pulse">30 LEVELS</div>
            </div>
          </div>

          <div className="p-3 bg-[#c6c6c6] mc-gui-inner flex flex-col gap-3">
            {/* Anvil MOTD Rename Bar */}
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-pixel text-[#373737] font-bold">
                SERVER MOTD NAME (RENAME ITEM)
              </label>
              <div className="bg-[#373737] p-2 border-2 border-[#131314] flex items-center gap-2">
                <span className="material-symbols-outlined text-[#dfc740] text-sm">edit</span>
                <input
                  type="text"
                  value={properties.motd}
                  onChange={(e) => updateProperties({ motd: e.target.value })}
                  className="bg-transparent text-white font-pixel text-xs w-full outline-none focus:text-[#dfc740]"
                />
              </div>
            </div>

            {/* Interactive Forging Recipe: World + Jar -> BDS Core */}
            <div className="flex flex-wrap items-center justify-center sm:justify-start gap-3 py-2 border-y-2 border-[#a0a0a0]">
              {/* Ingot Slot 1 */}
              <div className="flex flex-col items-center gap-1">
                <span className="text-[9px] font-pixel text-[#444]">PRIMARY WORLD</span>
                <div className="mc-slot w-12 h-12 flex items-center justify-center">
                  <span className="material-symbols-outlined text-[#97d85d] text-2xl">public</span>
                </div>
                <span className="text-[9px] font-pixel text-black font-bold truncate max-w-[90px]">
                  {properties.levelName}
                </span>
              </div>

              <span className="font-pixel text-lg text-[#555] font-bold">+</span>

              {/* Ingot Slot 2 */}
              <div className="flex flex-col items-center gap-1">
                <span className="text-[9px] font-pixel text-[#444]">BDS ENGINE JAR</span>
                <div className="mc-slot w-12 h-12 flex items-center justify-center">
                  <span className="material-symbols-outlined text-[#dfc740] text-2xl">dns</span>
                </div>
                <span className="text-[9px] font-pixel text-[#373737] font-bold">v1.21.30</span>
              </div>

              <span className="material-symbols-outlined text-[#373737] text-xl font-bold mx-1">
                arrow_forward
              </span>

              {/* Output Slot */}
              <div className="flex flex-col items-center gap-1">
                <span className="text-[9px] font-pixel text-[#7cbb43] font-bold">FORGED BDS CORE</span>
                <div className="mc-slot w-14 h-14 flex flex-col items-center justify-center bg-[#524700] border-2 border-yellow-300">
                  <span className="material-symbols-outlined text-[#FFE55C] text-2xl animate-bounce">
                    bolt
                  </span>
                  <span className="text-[8px] font-pixel text-white font-bold">DEPLOY</span>
                </div>
                <button
                  type="button"
                  onClick={hotReloadDeploy}
                  className="mc-btn px-2 py-0.5 text-[9px] font-pixel text-[#dfc740] font-bold mt-1"
                >
                  [FORGE & SYNC]
                </button>
              </div>
            </div>

            {/* Quick World Rules */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div className="bg-[#8b8b8b] border border-[#373737] p-2 flex flex-col gap-1">
                <span className="text-[9px] font-pixel text-white pixel-shadow font-bold">
                  GAME MODE
                </span>
                <div className="grid grid-cols-2 gap-1">
                  <button
                    type="button"
                    onClick={() => updateProperties({ gamemode: 'SURVIVAL' })}
                    className={`py-1 text-[8px] font-pixel border border-black font-bold ${
                      properties.gamemode === 'SURVIVAL'
                        ? 'bg-[#373737] text-[#dfc740]'
                        : 'bg-[#8b8b8b] text-[#222]'
                    }`}
                  >
                    SURVIVAL
                  </button>
                  <button
                    type="button"
                    onClick={() => updateProperties({ gamemode: 'CREATIVE' })}
                    className={`py-1 text-[8px] font-pixel border border-black font-bold ${
                      properties.gamemode === 'CREATIVE'
                        ? 'bg-[#373737] text-[#dfc740]'
                        : 'bg-[#8b8b8b] text-[#222]'
                    }`}
                  >
                    CREATIVE
                  </button>
                </div>
              </div>

              <div className="bg-[#8b8b8b] border border-[#373737] p-2 flex flex-col gap-1">
                <span className="text-[9px] font-pixel text-white pixel-shadow font-bold">
                  MAX PLAYER SLOTS
                </span>
                <div className="flex items-center justify-between bg-[#373737] p-1 border border-black">
                  <button
                    type="button"
                    onClick={() => adjustSlots(-1)}
                    className="mc-btn px-2 text-xs font-pixel text-white"
                  >
                    -
                  </button>
                  <span className="text-[#dfc740] font-pixel text-[10px] font-bold">
                    {properties.maxPlayers} SLOTS
                  </span>
                  <button
                    type="button"
                    onClick={() => adjustSlots(1)}
                    className="mc-btn px-2 text-xs font-pixel text-white"
                  >
                    +
                  </button>
                </div>
              </div>

              <div className="bg-[#8b8b8b] border border-[#373737] p-2 flex flex-col justify-between">
                <span className="text-[9px] font-pixel text-white pixel-shadow font-bold">
                  CHECKSUM HOOK
                </span>
                <label className="flex items-center gap-2 cursor-pointer bg-[#373737] px-2 py-1 border border-black">
                  <input
                    type="checkbox"
                    checked={isSimulatingCrash}
                    onChange={(e) => setSimulateCrash(e.target.checked)}
                    className="accent-[#ff8782] w-3.5 h-3.5"
                  />
                  <span className="text-[8px] font-pixel text-white">Simulate Crash</span>
                </label>
              </div>
            </div>
          </div>
        </div>

        {/* 2B. BOOK & QUILL: OP ROSTER */}
        <div className="lg:col-span-4 mc-gui-window p-3 sm:p-4 text-[#373737] flex flex-col gap-3">
          <div className="flex items-center justify-between pb-2 border-b-2 border-[#8b8b8b]">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[#373737] text-[22px]">auto_stories</span>
              <h3 className="text-[#2b2b2b] font-pixel text-xs sm:text-sm font-bold tracking-wider">
                BOOK & QUILL: OP ROSTER
              </h3>
            </div>
            <span className="bg-[#373737] text-[#dfc740] text-[8px] font-pixel px-1.5 py-0.5">
              permissions.json
            </span>
          </div>

          <div className="p-3 bg-[#c6c6c6] mc-gui-inner flex flex-col gap-3">
            {/* AlexMiner Host Card */}
            <div className="flex items-center gap-2.5 bg-[#8b8b8b] p-2 border-2 border-[#373737]">
              <div className="w-14 h-14 bg-[#131314] border-2 border-black flex items-center justify-center p-0.5 relative shadow-inner shrink-0">
                <img
                  src={ASSETS.ALEX_SKIN}
                  alt="Alex"
                  className="w-full h-full object-cover"
                />
                <div className="absolute -bottom-1 -right-1 bg-[#7cbb43] text-black text-[7px] font-pixel px-1 font-bold">
                  OP 4
                </div>
              </div>
              <div className="flex-1 font-pixel text-[10px] text-left leading-tight">
                <div className="text-white pixel-shadow font-bold">Alex_Miner (Host)</div>
                <div className="text-[#dfc740] text-[8px] select-all font-mono mt-0.5">
                  XUID: 2535412894129841
                </div>
                <div className="text-[#222] text-[8px] mt-1 font-jb">
                  Full BDS RCON & Command Block Immunity
                </div>
              </div>
            </div>

            {/* Operators List */}
            <div className="flex flex-col gap-1">
              <div className="text-[9px] font-pixel text-[#373737] font-bold uppercase">
                Enrolled Operators
              </div>
              {operators.map((op, idx) => (
                <div
                  key={op.xuid}
                  className="bg-[#373737] p-1.5 border border-black flex items-center justify-between text-white font-jb text-xs"
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-[#7cbb43] font-bold text-[10px]">#{idx + 1}</span>
                    <div className="min-w-0">
                      <div className="text-white text-[11px] font-bold truncate">{op.name}</div>
                      <div className="text-[#888] text-[9px] font-mono select-all truncate">{op.xuid}</div>
                    </div>
                  </div>
                  {!op.isHost && (
                    <button
                      type="button"
                      onClick={() => removeOperator(op.xuid)}
                      className="text-red-400 hover:text-red-200"
                      title="Revoke OP"
                    >
                      <span className="material-symbols-outlined text-[15px]">remove_circle</span>
                    </button>
                  )}
                </div>
              ))}
            </div>

            {/* Add OP Input Box */}
            <div className="flex items-center gap-1 pt-1">
              <input
                type="text"
                placeholder="16-digit XUID..."
                value={newXuid}
                onChange={(e) => setNewXuid(e.target.value)}
                className="bg-[#373737] text-white text-[10px] font-pixel p-1.5 border border-black flex-1 outline-none"
              />
              <button
                type="button"
                onClick={handleAddOp}
                className="mc-btn px-2 py-1 text-[9px] font-pixel text-[#dfc740] font-bold"
              >
                + ENSCRIBE
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* SIDE MULTIPLAYER CHAT & TERMINAL DRAWER (Toggled via button or 'T' key) */}
      <aside
        className={`fixed top-20 right-0 bottom-24 w-80 sm:w-96 bg-[rgba(14,14,14,0.95)] border-l-4 border-t-4 border-b-4 border-[#373737] z-50 p-3 flex flex-col gap-2 shadow-2xl backdrop-blur-md transform transition-transform duration-200 ${
          chatDrawerOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between pb-1 border-b border-[#373737]">
          <div className="flex items-center gap-1.5 text-[#dfc740] font-pixel text-xs">
            <span className="material-symbols-outlined text-sm">terminal</span>
            <span>BEDROCK MULTIPLAYER CHAT & LOG</span>
          </div>
          <button
            type="button"
            onClick={() => setChatDrawerOpen(false)}
            className="text-white hover:text-[#ff8782] text-xs font-pixel"
          >
            [X]
          </button>
        </div>

        {/* Chat message stream */}
        <div className="flex-1 overflow-y-auto flex flex-col gap-1 font-jb text-xs leading-relaxed pr-1 select-text">
          {logs.slice(-25).map((l) => (
            <div key={l.id} className="text-[#c2c9b5]">
              <span className="text-[#888]">[{l.timestamp}] </span>
              <span className="text-[#dfc740] font-bold">&lt;{l.tag}&gt; </span>
              <span>{l.message}</span>
            </div>
          ))}
        </div>

        {/* Drawer prompt */}
        <div className="flex items-center gap-1 bg-[#000000] border border-[#555] p-1">
          <span className="text-[#dfc740] font-pixel text-xs px-1">/</span>
          <input
            type="text"
            value={drawerInput}
            onChange={(e) => setDrawerInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleDrawerSend()}
            placeholder="Type command or broadcast..."
            className="bg-transparent text-white font-jb text-xs w-full outline-none"
          />
          <button
            type="button"
            onClick={handleDrawerSend}
            className="mc-btn px-2 py-0.5 text-[10px] font-pixel text-[#7cbb43]"
          >
            SEND
          </button>
        </div>
      </aside>
    </div>
  );
}
