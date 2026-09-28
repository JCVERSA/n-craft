import { motion } from 'motion/react';
import { useDialogs } from './DialogProvider.tsx';
import { useServer } from '../context/ServerContext.tsx';

interface HotbarAction {
  slot: number;
  label: string;
  icon: string;
  color: string;
  command?: string;
  actionKey?: 'deploy' | 'whitelist' | 'backup' | 'stop';
  tooltipTitle: string;
  tooltipDesc: string;
}

const ACTIONS: HotbarAction[] = [
  {
    slot: 1,
    label: '/tps',
    icon: 'speed',
    color: 'text-[#97d85d]',
    command: '/tps',
    tooltipTitle: '[1] Query TPS',
    tooltipDesc: 'Executes: /tps (Tick Stability)',
  },
  {
    slot: 2,
    label: '/list',
    icon: 'format_list_bulleted',
    color: 'text-[#dfc740]',
    command: '/list',
    tooltipTitle: '[2] List Players',
    tooltipDesc: 'Executes: /list (Online Roster)',
  },
  {
    slot: 3,
    label: '/day',
    icon: 'light_mode',
    color: 'text-[#FFE55C]',
    command: '/time set day',
    tooltipTitle: '[3] Solar Dawn',
    tooltipDesc: 'Executes: /time set day',
  },
  {
    slot: 4,
    label: '/clear',
    icon: 'wb_sunny',
    color: 'text-cyan-300',
    command: '/weather clear',
    tooltipTitle: '[4] Dispel Tempest',
    tooltipDesc: 'Executes: /weather clear',
  },
  {
    slot: 5,
    label: '/save',
    icon: 'save',
    color: 'text-emerald-400',
    command: '/save-all',
    tooltipTitle: '[5] Sync Chunks',
    tooltipDesc: 'Flushes LevelDB chunks to disk',
  },
  {
    slot: 6,
    label: 'DEPLOY',
    icon: 'rocket_launch',
    color: 'text-[#FFE55C]',
    actionKey: 'deploy',
    tooltipTitle: '[6] Deploy BDS Core',
    tooltipDesc: 'Hot reload engine & sync (Cost: 30 XP)',
  },
  {
    slot: 7,
    label: 'WL',
    icon: 'lock_open',
    color: 'text-stone-200',
    actionKey: 'whitelist',
    tooltipTitle: '[7] Toggle Whitelist',
    tooltipDesc: 'Toggles whitelist enforcement',
  },
  {
    slot: 8,
    label: 'BACKUP',
    icon: 'archive',
    color: 'text-amber-300',
    actionKey: 'backup',
    tooltipTitle: '[8] Level Backup',
    tooltipDesc: 'Compresses world snapshot (.mcworld)',
  },
  {
    slot: 9,
    label: 'STOP',
    icon: 'dangerous',
    color: 'text-[#ff8782]',
    actionKey: 'stop',
    tooltipTitle: '[9] EMERGENCY STOP',
    tooltipDesc: 'Kills BDS instance immediately',
  },
];

export function HotbarDock() {
  const dialogs = useDialogs();
  const {
    executeCommand,
    hotReloadDeploy,
    updateProperties,
    properties,
    stopServer,
    addLog,
  } = useServer();

  const handleSlotClick = async (action: HotbarAction) => {
    if (action.command) {
      executeCommand(action.command);
    } else if (action.actionKey === 'deploy') {
      hotReloadDeploy();
    } else if (action.actionKey === 'whitelist') {
      const next = !properties.whitelistEnforced;
      updateProperties({ whitelistEnforced: next });
      addLog(
        next
          ? 'Whitelist is now ENFORCED. Unlisted players will be kicked.'
          : 'Whitelist is now PUBLIC.',
        'SECURITY',
        next ? 'warn' : 'info'
      );
    } else if (action.actionKey === 'backup') {
      addLog(
        `Compressing Level ${properties.levelName} to /backups/2026-snapshot.mcworld... (642 MB written)`,
        'BACKUP',
        'success'
      );
    } else if (action.actionKey === 'stop') {
      const confirmed = await dialogs.confirm({
        title: 'Arrêter le serveur Bedrock ?',
        message: 'Tous les joueurs seront déconnectés et l’instance Bedrock sera arrêtée immédiatement.',
        eyebrow: 'ARRÊT D’URGENCE · BEDROCK',
        tone: 'danger',
        confirmLabel: 'Arrêter le serveur',
        cancelLabel: 'Annuler',
      });
      if (confirmed) stopServer();
    }
  };

  return (
    <footer className="fixed bottom-0 left-0 right-0 z-40 bg-[rgba(19,19,20,0.96)] border-t-2 border-[#0e0e0e] py-1.5 px-2 flex flex-col items-center justify-center backdrop-blur-md">
      {/* XP Level Bar */}
      <div className="w-full max-w-sm flex flex-col items-center mb-1">
        <div className="relative w-full h-2 bg-[#000000] border border-[#373737] overflow-hidden">
          <motion.div
            className="h-full bg-gradient-to-r from-[#7cbb43] via-[#FFE55C] to-[#7cbb43]"
            initial={{ width: 0 }}
            animate={{ width: '78%' }}
            transition={{ type: 'spring', stiffness: 200, damping: 25 }}
          />
        </div>
        <span className="text-[#FFE55C] font-pixel text-[10px] font-bold pixel-shadow-green -mt-3 z-10 select-none">
          30
        </span>
      </div>

      {/* 9-Slot Hotbar Container */}
      <div className="flex items-center justify-center gap-1 sm:gap-1.5 p-1 bg-[#c6c6c6] mc-gui-window max-w-full overflow-x-auto shadow-2xl">
        {ACTIONS.map((item) => (
          <div key={item.slot} className="relative group">
            <motion.button
              type="button"
              whileTap={{ scale: 0.92, y: 1 }}
              whileHover={{ y: -2 }}
              transition={{ type: 'spring', stiffness: 500, damping: 28 }}
              onClick={() => { void handleSlotClick(item); }}
              className={`mc-slot w-10 h-10 sm:w-11 sm:h-11 flex flex-col items-center justify-center relative cursor-pointer ${
                item.actionKey === 'deploy' ? 'bg-[#524700]' : ''
              } ${item.actionKey === 'stop' ? 'bg-[#93000a]' : ''}`}
            >
              <span className={`material-symbols-outlined text-[19px] ${item.color}`}>
                {item.icon}
              </span>
              <span className="text-[8px] font-pixel text-white pixel-shadow absolute bottom-0.5 right-1 pointer-events-none">
                {item.slot}
              </span>
            </motion.button>

            {/* Hover Tooltip */}
            <div className="hidden group-hover:block absolute bottom-[calc(100%+8px)] left-1/2 -translate-x-1/2 bg-[#110e1a] border-2 border-[#2b1154] p-2 z-50 whitespace-nowrap shadow-xl pointer-events-none">
              <div className="text-[#FFE55C] font-pixel text-[10px]">{item.tooltipTitle}</div>
              <div className="text-[#c2c9b5] font-jb text-[9px] mt-0.5">{item.tooltipDesc}</div>
            </div>
          </div>
        ))}
      </div>
    </footer>
  );
}

