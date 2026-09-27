import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useServer } from '../context/ServerContext.tsx';
import { ASSETS } from '../types/server.ts';
import { playClickSound, playXpSound } from '../utils/audio.ts';

export function OperatorAuthView() {
  const { telemetry, properties, setCurrentView, addLog } = useServer();
  const [tokenInput, setTokenInput] = useState('op_key_97d85d7cbb43');
  const [rememberMe, setRememberMe] = useState(true);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [authSuccess, setAuthSuccess] = useState(false);
  const [pingStatus, setPingStatus] = useState<string | null>(null);

  const handlePaste = async () => {
    playClickSound();
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText();
        if (text) setTokenInput(text.trim());
      }
    } catch {
      // Fallback
    }
  };

  const handleAuthenticate = () => {
    playClickSound();
    setIsAuthenticating(true);
    setAuthSuccess(false);

    setTimeout(() => {
      setIsAuthenticating(false);
      setAuthSuccess(true);
      playXpSound();
      addLog('Operator authenticated via master token: Level 4 OP clearance granted.', 'AUTH', 'success');

      setTimeout(() => {
        setAuthSuccess(false);
        setCurrentView('dashboard');
      }, 1400);
    }, 1200);
  };

  const handlePingHost = () => {
    playClickSound();
    setPingStatus('PINGING...');
    setTimeout(() => {
      setPingStatus(`${telemetry.pingMs}ms [OK]`);
      setTimeout(() => setPingStatus(null), 2500);
    }, 600);
  };

  return (
    <div className="w-full flex flex-col items-center justify-center py-6 px-4 max-w-xl mx-auto pb-24">
      {/* Atmospheric Ambient Glow */}
      <div className="absolute -top-12 left-1/2 -translate-x-1/2 w-96 h-48 bg-[#97d85d]/10 rounded-full blur-3xl pointer-events-none" />

      {/* Panorama Showcase Hero Backdrop */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 350, damping: 25 }}
        className="relative w-full h-44 mb-2 overflow-hidden shadow-2xl bg-[#0e0e0e] mc-bevel"
      >
        <div
          className="w-full h-full bg-cover bg-center"
          style={{ backgroundImage: `url('${ASSETS.PANORAMA}')` }}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-[#0e0e0e] via-[#0e0e0e]/50 to-transparent" />

        {/* Realm Title Banner inside Hero */}
        <div className="absolute bottom-3 left-4 right-4 flex items-end justify-between">
          <div>
            <span className="inline-block px-2 py-0.5 mb-1 bg-[#343535] text-[#97d85d] font-pixel text-[8px] uppercase tracking-wider mc-bevel">
              Bedrock Dedicated Server
            </span>
            <h2 className="font-pixel text-base sm:text-lg text-white tracking-tight drop-shadow-md pixel-shadow">
              NEBULA CRAFT
            </h2>
          </div>
          <div className="flex items-center gap-1.5 bg-[#2a2a2a]/90 px-2.5 py-1 backdrop-blur-sm mc-inset">
            <span className="w-2 h-2 rounded-full bg-[#97d85d] animate-pulse" />
            <span className="font-jb text-[10px] text-[#97d85d] tracking-wide font-bold">
              ONLINE ({telemetry.playersOnline}/{properties.maxPlayers})
            </span>
          </div>
        </div>
      </motion.div>

      {/* Yellow Splash Text Badge with Wiggle */}
      <div className="relative z-10 -mb-3 flex justify-center w-full">
        <motion.div
          whileHover={{ scale: 1.08, rotate: 0 }}
          className="splash-bounce inline-flex items-center gap-1.5 px-3 py-1 bg-[#dfc740] text-[#393000] shadow-lg mc-bevel-gold cursor-default select-none"
        >
          <span className="material-symbols-outlined text-[15px]">bolt</span>
          <span className="font-pixel text-[9px] tracking-wider uppercase font-bold">
            Now with Bedrock 1.21.30 protocol support!
          </span>
        </motion.div>
      </div>


      {/* Main Bedrock Operator Dialog Modal */}
      <div className="w-full bg-[#2a2a2a] mc-bevel shadow-2xl p-4 flex flex-col gap-4 mt-2">
        {/* Dialog Header Bar */}
        <div className="flex items-center justify-between bg-[#343535] p-2.5 mc-inset">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 bg-[#0e0e0e] mc-inset flex items-center justify-center text-[#97d85d]">
              <span className="material-symbols-outlined text-[22px]">security</span>
            </div>
            <div>
              <h1 className="font-pixel text-xs text-white tracking-wide uppercase">
                OPERATOR ACCESS
              </h1>
              <p className="font-jb text-[9px] text-[#c2c9b5] tracking-widest uppercase">
                DIRECT CONNECTION // AUTH LEVEL 4
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1 text-[#8c9380] font-jb text-xs">
            <span className="material-symbols-outlined text-[16px]">verified_user</span>
            <span>BDS</span>
          </div>
        </div>

        {/* Quick Server Info Banner */}
        <div className="bg-[#1b1c1c] p-2.5 mc-inset flex items-center justify-between">
          <div className="flex flex-col">
            <span className="font-jb text-[9px] text-[#c2c9b5] uppercase">
              Target Server Address
            </span>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="font-jb text-xs sm:text-sm text-[#97d85d] font-bold font-mono">
                nebula.craft.playit.gg
              </span>
              <span className="font-jb text-[10px] text-[#dfc740] bg-[#343535] px-1.5 py-0.5 mc-inset">
                PORT: 19132
              </span>
            </div>
          </div>

          {/* Bedrock Signal Bars */}
          <div className="flex flex-col items-end">
            <div className="flex items-end gap-1 h-5 mb-0.5">
              <span className="w-1.5 h-1.5 bg-[#97d85d]" />
              <span className="w-1.5 h-2.5 bg-[#97d85d]" />
              <span className="w-1.5 h-3.5 bg-[#97d85d]" />
              <span className="w-1.5 h-4.5 bg-[#97d85d]" />
              <span className="w-1.5 h-5 bg-[#97d85d] animate-pulse" />
            </div>
            <span className="font-jb text-[10px] text-[#97d85d] font-bold">
              {pingStatus || `${telemetry.pingMs}ms • 60 TPS`}
            </span>
          </div>
        </div>

        {/* Form Inputs Group */}
        <div className="flex flex-col gap-1.5">
          <div className="flex justify-between items-center font-jb text-[10px]">
            <label className="text-[#c2c9b5] tracking-wider uppercase font-bold">
              Panel Security Token
            </label>
            <span className="text-[#8c9380]">KEY FORMAT: UUIDv4</span>
          </div>

          {/* Recessed Command Input Box */}
          <div className="relative bg-[#0e0e0e] p-2 mc-inset flex items-center">
            <span className="text-[#97d85d] font-pixel text-xs mr-2 select-none">&gt;</span>
            <input
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="Enter operator master key..."
              className="w-full bg-transparent text-white font-mono text-xs focus:outline-none tracking-wider"
            />
            <button
              type="button"
              onClick={handlePaste}
              className="ml-2 px-2.5 py-1 bg-[#2a2a2a] hover:bg-[#343535] mc-stone-btn text-white flex items-center gap-1"
              title="Paste token from clipboard"
            >
              <span className="material-symbols-outlined text-[14px]">content_paste</span>
              <span className="font-jb text-[10px] uppercase hidden sm:inline">PASTE</span>
            </button>
          </div>
          <p className="font-space text-[10px] text-[#8c9380]">
            Enter your master server token or bedrock realm operator key. Never share this with unauthenticated players.
          </p>
        </div>

        {/* Remember Checkbox Control */}
        <label className="flex items-center gap-3 cursor-pointer select-none bg-[#1b1c1c] p-2 mc-inset">
          <input
            type="checkbox"
            checked={rememberMe}
            onChange={(e) => setRememberMe(e.target.checked)}
            className="peer sr-only"
          />
          <div className="w-5 h-5 bg-[#0e0e0e] mc-inset flex items-center justify-center peer-checked:bg-[#7cbb43]">
            {rememberMe && (
              <span className="material-symbols-outlined text-[16px] text-[#1b3700] font-bold">
                check
              </span>
            )}
          </div>
          <span className="font-jb text-xs text-[#e4e2e2]">
            Remember operator credentials on this workstation
          </span>
        </label>

        {/* Action Buttons Grid */}
        <div className="flex flex-col gap-2 pt-1">
          {/* Main Authenticate Button */}
          <motion.button
            type="button"
            whileTap={{ scale: 0.96 }}
            onClick={handleAuthenticate}
            disabled={isAuthenticating}
            className={`w-full h-11 font-pixel text-xs uppercase tracking-wider flex items-center justify-center gap-2 cursor-pointer ${
              authSuccess
                ? 'bg-[#7cbb43] text-[#1b3700] mc-bevel-green'
                : isAuthenticating
                ? 'bg-[#a99300] text-[#393000] mc-bevel-gold'
                : 'bg-[#97d85d] text-[#1b3700] hover:bg-[#b2f575] mc-bevel-green font-bold'
            }`}
          >
            {authSuccess ? (
              <>
                <span className="material-symbols-outlined text-[18px]">check_circle</span>
                <span>OPERATOR VERIFIED! REDIRECTING...</span>
              </>
            ) : isAuthenticating ? (
              <>
                <span className="material-symbols-outlined text-[18px] animate-spin">refresh</span>
                <span>CONNECTING TO BDS ENGINE...</span>
              </>
            ) : (
              <>
                <span className="material-symbols-outlined text-[18px]">login</span>
                <span>AUTHENTICATE & JOIN SERVER</span>
              </>
            )}
          </motion.button>

          {/* Secondary Actions */}
          <div className="grid grid-cols-2 gap-2">
            <motion.button
              type="button"
              whileTap={{ scale: 0.94 }}
              onClick={handlePingHost}
              className="h-9 bg-[#343535] mc-stone-btn text-[#e4e2e2] font-jb text-xs uppercase tracking-wide hover:text-white flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <span className="material-symbols-outlined text-[15px]">sync</span>
              <span>PING HOST</span>
            </motion.button>
            <motion.button
              type="button"
              whileTap={{ scale: 0.94 }}
              onClick={() => setCurrentView('dashboard')}
              className="h-9 bg-[#343535] mc-stone-btn text-[#e4e2e2] font-jb text-xs uppercase tracking-wide hover:text-white flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <span className="material-symbols-outlined text-[15px]">terminal</span>
              <span>WEB CONSOLE</span>
            </motion.button>
          </div>
        </div>

        {/* Telemetry Status Bar */}
        <div className="bg-[#0e0e0e] p-2.5 mc-inset flex flex-col gap-2 font-jb">
          <div className="flex justify-between items-center text-[10px] text-[#8c9380]">
            <span className="uppercase">Active Server World</span>
            <span className="text-[#e4e2e2] font-bold">{properties.levelName}</span>
          </div>

          {/* Allocated BDS RAM */}
          <div className="flex flex-col gap-1">
            <div className="flex justify-between items-center text-[10px]">
              <span className="text-[#c2c9b5]">Allocated BDS RAM</span>
              <span className="text-[#97d85d] font-bold">
                {(telemetry.ramUsedMb / 1024).toFixed(1)} GB / 8.0 GB (
                {Math.round((telemetry.ramUsedMb / telemetry.ramTotalMb) * 100)}%)
              </span>
            </div>
            <div className="w-full h-2.5 bg-[#2a2a2a] mc-inset overflow-hidden flex">
              <div
                className="h-full bg-[#97d85d]"
                style={{ width: `${Math.round((telemetry.ramUsedMb / telemetry.ramTotalMb) * 100)}%` }}
              />
              <div className="h-full bg-[#dfc740] w-[8%]" />
            </div>
          </div>
        </div>
      </div>

      {/* Footnote Meta Bar */}
      <div className="w-full mt-3 flex flex-col sm:flex-row items-center justify-between gap-1 text-center font-jb text-[10px] text-[#8c9380] px-1">
        <span className="tracking-widest uppercase">Bedrock Dedicated Server (BDS) • Protocol v671</span>
        <span className="text-[#97d85d]">BUILD 2024.11-STABLE</span>
      </div>
    </div>
  );
}
