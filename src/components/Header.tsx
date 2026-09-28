import { motion } from 'motion/react';
import { useServer } from '../context/ServerContext.tsx';
import { ScreenView, ASSETS } from '../types/server.ts';
import { playClickSound } from '../utils/audio.ts';
import { NebulaBrandMark } from './NebulaBrandMark.tsx';

interface ViewTab {
  id: ScreenView;
  label: string;
  icon: string;
}

const TABS: ViewTab[] = [
  { id: 'dashboard', label: 'SERVER DASHBOARD', icon: 'dashboard' },
  { id: 'operator-auth', label: 'OPERATOR ACCESS', icon: 'key' },
  { id: 'chest-matrix', label: 'CHEST MATRIX (54)', icon: 'inventory_2' },
  { id: 'node-pipeline', label: 'NODE PIPELINE', icon: 'hub' },
  { id: 'f3-telemetry', label: 'F3 TELEMETRY', icon: 'terminal' },
];

export function Header() {
  const {
    currentView,
    setCurrentView,
    serverStatus,
    telemetry,
    properties,
    soundMuted,
    toggleSound,
    stopServer,
    restartServer,
    copyIp,
    copiedNotice,
  } = useServer();

  const handleTabClick = (view: ScreenView) => {
    playClickSound();
    setCurrentView(view);
  };

  return (
    <header className="w-full bg-[#1b1c1c] border-b-2 border-[#0e0e0e] sticky top-0 z-50 shadow-2xl">
      {/* Top Main Command Bar */}
      <div className="h-20 w-full px-3 sm:px-6 flex items-center justify-between gap-3">
        {/* Left: Crest, Title, Bedrock Version */}
        <div className="flex items-center gap-2.5 sm:gap-4">
          <motion.div
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            className="p-1 bg-[#0e0e0e] mc-inset flex items-center justify-center shrink-0 relative group cursor-pointer"
            onClick={() => handleTabClick('dashboard')}
          >
            <NebulaBrandMark alt="Emblème Nebula Craft" className="nebula-brand-mark--header" />
            {serverStatus === 'RUNNING' && (
              <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-[#97d85d] mc-bevel animate-ping" />
            )}
          </motion.div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-pixel text-xs sm:text-base tracking-wider text-[#dfc740] pixel-shadow-gold">
                NEBULA CRAFT
              </span>
              <span className="px-1.5 py-0.5 bg-[#7cbb43] text-[#1b3700] font-pixel text-[8px] sm:text-[9px] uppercase font-bold mc-bevel">
                BEDROCK
              </span>
            </div>
            <p className="font-jb text-[10px] sm:text-xs text-[#c2c9b5] tracking-wide mt-0.5">
              BEDROCK SERVER CONSOLE v1.21.30
            </p>
          </div>
        </div>

        {/* Center: Live Connection HUD (Desktop / Tablet) */}
        <div className="hidden lg:flex items-center gap-3 px-3 py-1.5 bg-[#1f2020] mc-inset">
          <div className="flex items-center gap-2">
            <div
              className={`w-3 h-3 mc-bevel ${
                serverStatus === 'RUNNING'
                  ? 'bg-[#97d85d] animate-pulse'
                  : serverStatus === 'RESTARTING'
                  ? 'bg-[#dfc740] animate-spin'
                  : 'bg-[#ff8782]'
              }`}
            />
            <div className="leading-tight">
              <div className="font-jb text-xs text-[#97d85d] flex items-center gap-1.5 font-bold">
                <span>{serverStatus}</span>
                <span className="text-[#c2c9b5] text-[11px] font-normal">
                  ({telemetry.playersOnline}/{properties.maxPlayers} PLAYERS)
                </span>
              </div>
              <div className="font-jb text-[10px] text-[#c2c9b5] flex items-center gap-1">
                <span className="text-[#dfc740] font-bold">{telemetry.pingMs}ms</span>
                <span>PING // 20.0 TPS</span>
              </div>
            </div>
          </div>

          <div className="h-6 w-0.5 bg-[#343535]" />

          {/* Host Endpoint & Copy IP */}
          <div className="flex items-center gap-1.5 bg-[#0e0e0e] px-2 py-1 mc-inset">
            <span className="font-jb text-[11px] text-[#e4e2e2] select-all font-mono">
              {ASSETS.SERVER_IP}
            </span>
            <motion.button
              type="button"
              whileTap={{ scale: 0.94 }}
              onClick={copyIp}
              className="mc-stone-btn bg-[#2a2a2a] px-2 py-0.5 text-[10px] font-jb text-[#e4e2e2] hover:text-[#dfc740] flex items-center gap-1 uppercase"
              title="Copy server IP"
            >
              <span className="material-symbols-outlined text-[13px]">
                {copiedNotice ? 'check' : 'content_copy'}
              </span>
              <span>{copiedNotice ? '[COPIED!]' : '[COPY]'}</span>
            </motion.button>
          </div>
        </div>

        {/* Right: Audio Toggle, World Pill, Alex OP User Badge, Power */}
        <div className="flex items-center gap-2 sm:gap-3">
          {/* Active Level World Pill */}
          <div className="hidden xl:flex items-center gap-1.5 mc-inset bg-[#0e0e0e] px-2.5 py-1 text-xs font-jb">
            <span className="material-symbols-outlined text-[#97d85d] text-[16px]">public</span>
            <span className="text-[#e4e2e2] font-mono truncate max-w-[130px]">{properties.levelName}</span>
          </div>

          {/* Sound FX Toggle Button */}
          <motion.button
            type="button"
            whileTap={{ scale: 0.92 }}
            onClick={toggleSound}
            className={`mc-stone-btn p-1.5 flex items-center justify-center ${
              soundMuted ? 'bg-[#93000a] text-[#ffdad6]' : 'bg-[#2a2a2a] text-[#e4e2e2] hover:text-[#dfc740]'
            }`}
            title={soundMuted ? 'Sound Muted (Click to Unmute)' : 'Sound Enabled (Click to Mute)'}
          >
            <span className="material-symbols-outlined text-[18px]">
              {soundMuted ? 'volume_off' : 'volume_up'}
            </span>
          </motion.button>

          {/* Player Skin Doll Profile Chip */}
          <div className="flex items-center gap-2 pl-2 sm:pl-3 border-l-2 border-[#343535]">
            <div className="w-8 h-8 rounded-none bg-[#0e0e0e] mc-inset p-0.5 shrink-0 relative overflow-hidden">
              <img
                src={ASSETS.ALEX_SKIN}
                alt="Alex_Miner Avatar"
                className="w-full h-full object-cover"
              />
            </div>
            <div className="text-left hidden md:block">
              <div className="font-pixel text-[10px] text-[#dfc740]">Alex_Miner</div>
              <div className="font-pixel text-[8px] text-[#97d85d]">[OP LEVEL 4]</div>
            </div>

            {/* Quick Action: Restart / Stop */}
            <motion.button
              type="button"
              whileTap={{ scale: 0.92 }}
              onClick={restartServer}
              className="mc-stone-btn bg-[#2a2a2a] p-1.5 text-[#dfc740] hover:text-white"
              title="Restart BDS Engine"
            >
              <span className="material-symbols-outlined text-[18px]">refresh</span>
            </motion.button>
            <motion.button
              type="button"
              whileTap={{ scale: 0.92 }}
              onClick={stopServer}
              className="mc-bevel bg-[#93000a] text-[#ffdad6] p-1.5 hover:bg-[#ff5555] hover:text-black"
              title="Stop BDS Server"
            >
              <span className="material-symbols-outlined text-[18px]">power_settings_new</span>
            </motion.button>
          </div>
        </div>
      </div>

      {/* Screen View Switcher Tabs Bar */}
      <div className="w-full bg-[#0e0e0e] px-4 overflow-x-auto mc-inset">
        <nav className="flex items-center gap-1 min-w-max py-0.5">
          {TABS.map((tab) => {
            const isActive = currentView === tab.id;
            return (
              <motion.button
                key={tab.id}
                type="button"
                whileTap={{ scale: 0.96 }}
                onClick={() => handleTabClick(tab.id)}
                className={`relative px-3 py-2 font-pixel text-[10px] uppercase tracking-wider flex items-center gap-1.5 transition-none ${
                  isActive
                    ? 'bg-[#1f2020] text-[#dfc740] border-t-2 border-l-2 border-r-2 border-[#dfc740] -mb-[2px] font-bold shadow-md'
                    : 'text-[#c2c9b5] hover:text-[#e4e2e2] hover:bg-[#2a2a2a]'
                }`}
              >
                <span className="material-symbols-outlined text-[15px]">{tab.icon}</span>
                <span>[{tab.label}]</span>
                {isActive && (
                  <motion.div
                    layoutId="activeTabUnderline"
                    className="absolute -bottom-[2px] left-0 right-0 h-0.5 bg-[#dfc740]"
                    transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                  />
                )}
              </motion.button>
            );
          })}
        </nav>
      </div>
    </header>
  );
}

