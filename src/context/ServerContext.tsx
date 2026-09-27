import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import {
  ScreenView,
  ServerStatus,
  ServerProperties,
  Operator,
  LogEntry,
  TelemetryData,
  ASSETS,
} from '../types/server.ts';
import {
  playClickSound,
  playAnvilSound,
  playXpSound,
  playLeverSound,
  playErrorSound,
  setSoundEnabled,
  isSoundEnabled,
} from '../utils/audio.ts';

interface ServerContextType {
  currentView: ScreenView;
  setCurrentView: (view: ScreenView) => void;
  serverStatus: ServerStatus;
  properties: ServerProperties;
  updateProperties: (patch: Partial<ServerProperties>) => void;
  operators: Operator[];
  addOperator: (name: string, xuid: string, level?: number) => boolean;
  removeOperator: (xuid: string) => void;
  demoteOperator: (xuid: string) => void;
  banUser: (name: string) => void;
  logs: LogEntry[];
  addLog: (message: string, tag?: string, level?: LogEntry['level']) => void;
  clearLogs: () => void;
  executeCommand: (cmd: string) => void;
  telemetry: TelemetryData;
  pipelineStep: number;
  isSimulatingCrash: boolean;
  setSimulateCrash: (crash: boolean) => void;
  restartServer: () => void;
  stopServer: () => void;
  hotReloadDeploy: () => void;
  soundMuted: boolean;
  toggleSound: () => void;
  chatDrawerOpen: boolean;
  setChatDrawerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  copiedNotice: boolean;
  copyIp: () => void;
  formatUptime: (seconds: number) => string;
}

const initialProperties: ServerProperties = {
  motd: 'Nebula Realm S4 - Tricky Trials',
  levelName: 'BedrockWorld_Survival',
  gamemode: 'SURVIVAL',
  difficulty: 'NORMAL',
  maxPlayers: 20,
  seed: '8492049104812948',
  viewDistance: 16,
  tickDistance: 4,
  allowCheats: true,
  whitelistEnforced: false,
  engineVersion: 'v1.21.30 (Latest Stable - Bedrock)',
};

const initialOperators: Operator[] = [
  {
    name: 'AlexMiner',
    xuid: '2535412894129841',
    level: 4,
    badge: 'BADGE #001',
    isHost: true,
  },
  {
    name: 'SteveBuilder',
    xuid: '2535489019283742',
    level: 4,
    badge: 'BADGE #002',
  },
  {
    name: 'CraftyCrafter',
    xuid: '2535433190821098',
    level: 3,
    badge: 'MODERATOR',
  },
];

const initialLogs: LogEntry[] = [
  {
    id: '1',
    timestamp: '14:22:01',
    tag: 'BDS',
    message: 'Starting Bedrock Dedicated Server version v1.21.30.03',
    level: 'info',
  },
  {
    id: '2',
    timestamp: '14:22:04',
    tag: 'BDS',
    message: 'IPv4 supported, port: 19132 (UDP/RakNet)',
    level: 'info',
  },
  {
    id: '3',
    timestamp: '14:22:06',
    tag: 'Playit.gg',
    message: `Tunnel active at ${ASSETS.SERVER_IP}`,
    level: 'success',
  },
  {
    id: '4',
    timestamp: '14:23:12',
    tag: 'AUTH',
    message: 'Player connected: AlexMiner (xuid: 2535412894129841)',
    level: 'success',
  },
  {
    id: '5',
    timestamp: '14:24:45',
    tag: 'AUTH',
    message: 'Player connected: SteveBuilder (xuid: 2535489019283742)',
    level: 'success',
  },
  {
    id: '6',
    timestamp: '14:25:30',
    tag: 'WARN',
    message: "Can't keep up! Did the system time change, or is the server overloaded? (Diff: 41ms)",
    level: 'warn',
  },
  {
    id: '7',
    timestamp: '14:26:01',
    tag: 'WORLD',
    message: "Saving worlds to /bedrock/worlds/BedrockWorld_Survival...",
    level: 'info',
  },
];

const ServerContext = createContext<ServerContextType | null>(null);

export function ServerProvider({ children }: { children: ReactNode }) {
  const [currentView, setCurrentView] = useState<ScreenView>('dashboard');
  const [serverStatus, setServerStatus] = useState<ServerStatus>('RUNNING');
  const [properties, setProperties] = useState<ServerProperties>(initialProperties);
  const [operators, setOperators] = useState<Operator[]>(initialOperators);
  const [logs, setLogs] = useState<LogEntry[]>(initialLogs);
  const [pipelineStep, setPipelineStep] = useState<number>(3);
  const [isSimulatingCrash, setIsSimulatingCrash] = useState<boolean>(false);
  const [soundMuted, setSoundMuted] = useState<boolean>(false);
  const [chatDrawerOpen, setChatDrawerOpen] = useState<boolean>(false);
  const [copiedNotice, setCopiedNotice] = useState<boolean>(false);

  const [telemetry, setTelemetry] = useState<TelemetryData>({
    tps: 20.0,
    ramUsedMb: 3892,
    ramTotalMb: 8192,
    cpuPercent: 18,
    pingMs: 24,
    playersOnline: 12,
    playersMax: 20,
    uptimeSeconds: 412330, // ~4d 18h 32m 10s
  });

  const toggleSound = useCallback(() => {
    const next = !soundMuted;
    setSoundMuted(next);
    setSoundEnabled(!next);
  }, [soundMuted]);

  const addLog = useCallback((message: string, tag = 'BDS', level: LogEntry['level'] = 'info') => {
    const now = new Date();
    const timestamp = now.toTimeString().split(' ')[0];
    const newEntry: LogEntry = {
      id: Math.random().toString(36).substring(2, 9),
      timestamp,
      tag,
      message,
      level,
    };
    setLogs((prev) => [...prev.slice(-120), newEntry]);
  }, []);

  const clearLogs = useCallback(() => {
    playClickSound();
    setLogs([
      {
        id: Math.random().toString(36).substring(2, 9),
        timestamp: new Date().toTimeString().split(' ')[0],
        tag: 'TTY',
        message: '-- Terminal buffer flushed. Listening on Bedrock socket 19132 --',
        level: 'info',
      },
    ]);
  }, []);

  const updateProperties = useCallback((patch: Partial<ServerProperties>) => {
    setProperties((prev) => {
      const updated = { ...prev, ...patch };
      if (patch.allowCheats !== undefined && patch.allowCheats !== prev.allowCheats) {
        playLeverSound(patch.allowCheats);
      } else {
        playClickSound();
      }
      return updated;
    });
  }, []);

  const addOperator = useCallback((name: string, xuid: string, level = 4): boolean => {
    const cleanXuid = xuid.trim();
    if (!/^\d{16}$/.test(cleanXuid)) {
      playErrorSound();
      addLog(`Failed to enscribe operator: Invalid XUID "${cleanXuid}". 16-digit numeric Xbox ID required.`, 'SECURITY', 'error');
      return false;
    }
    playXpSound();
    const newOp: Operator = {
      name: name.trim() || `User_${cleanXuid.slice(-4)}`,
      xuid: cleanXuid,
      level,
      badge: `BADGE #${(operators.length + 1).toString().padStart(3, '0')}`,
    };
    setOperators((prev) => [...prev.filter((o) => o.xuid !== cleanXuid), newOp]);
    addLog(`Enscribed new Bedrock Operator ${newOp.name} (XUID: ${cleanXuid}, Level ${level}) into permissions.json`, 'PERMISSIONS', 'success');
    return true;
  }, [operators.length, addLog]);

  const removeOperator = useCallback((xuid: string) => {
    playClickSound();
    setOperators((prev) => {
      const target = prev.find((o) => o.xuid === xuid);
      if (target) {
        addLog(`Revoked Operator permissions for ${target.name} (${xuid})`, 'PERMISSIONS', 'warn');
      }
      return prev.filter((o) => o.xuid !== xuid);
    });
  }, [addLog]);

  const demoteOperator = useCallback((xuid: string) => {
    playClickSound();
    setOperators((prev) =>
      prev.map((o) => {
        if (o.xuid === xuid) {
          const nextLevel = o.level > 1 ? o.level - 1 : 1;
          addLog(`Demoted ${o.name} from OP Level ${o.level} to Level ${nextLevel}`, 'PERMISSIONS', 'warn');
          return { ...o, level: nextLevel };
        }
        return o;
      })
    );
  }, [addLog]);

  const banUser = useCallback((name: string) => {
    playErrorSound();
    addLog(`[BAN HAMMER] Applied ban to ${name}. Expelled from Bedrock socket.`, 'SECURITY', 'error');
    setOperators((prev) => prev.filter((o) => o.name !== name));
  }, [addLog]);

  const copyIp = useCallback(() => {
    playClickSound();
    navigator.clipboard.writeText(ASSETS.SERVER_IP);
    setCopiedNotice(true);
    setTimeout(() => setCopiedNotice(false), 2000);
  }, []);

  const restartServer = useCallback(() => {
    playClickSound();
    setServerStatus('RESTARTING');
    addLog('SIGTERM broadcasted. Restarting BDS daemon and preserving LevelDB state...', 'BDS', 'warn');
    setTimeout(() => {
      setServerStatus('RUNNING');
      playXpSound();
      addLog('BDS Engine restarted successfully. Socket listening on 19132. World state verified.', 'BDS', 'success');
    }, 2400);
  }, [addLog]);

  const stopServer = useCallback(() => {
    playErrorSound();
    setServerStatus('STOPPED');
    addLog('EMERGENCY: BDS Daemon stopped. All player connections severed.', 'SHUTDOWN', 'error');
  }, [addLog]);

  const hotReloadDeploy = useCallback(() => {
    playAnvilSound();
    setServerStatus('DEPLOYING');
    setPipelineStep(3);
    addLog('Deploy & Sync triggered: Validating behavior packs and syncing server.properties...', 'FORGE', 'info');
    setTimeout(() => {
      setPipelineStep(4);
      addLog('Step 4/6: Extracted behavior packs without checksum defects.', 'PIPELINE', 'info');
    }, 900);
    setTimeout(() => {
      setPipelineStep(5);
      addLog('Step 5/6: server.properties re-injected into BDS environment.', 'PIPELINE', 'info');
    }, 1700);
    setTimeout(() => {
      setPipelineStep(6);
      setServerStatus('RUNNING');
      playXpSound();
      addLog('Hot reload complete! Dedicated engine synchronized with active realm (30 XP consumed).', 'BDS', 'success');
    }, 2500);
  }, [addLog]);

  const setSimulateCrash = useCallback((crash: boolean) => {
    setIsSimulatingCrash(crash);
    if (crash) {
      playErrorSound();
      setServerStatus('CRASHED');
      addLog('[CRITICAL ERROR] STEP 4 CRASHED: YOU DIED. Checksum mismatch on behavior_pack_v2.zip!', 'PANIC', 'error');
    } else {
      playXpSound();
      setServerStatus('RUNNING');
      addLog('Crash simulated error cleared. Cache purged, resuming normal ticks at 20.0 TPS.', 'RECOVERY', 'success');
    }
  }, [addLog]);

  const executeCommand = useCallback((cmdRaw: string) => {
    const raw = cmdRaw.trim();
    if (!raw) return;
    const cmd = raw.startsWith('/') ? raw.slice(1) : raw;
    const parts = cmd.split(' ');
    const root = parts[0]?.toLowerCase();

    playClickSound();
    addLog(raw.startsWith('/') ? raw : `/${raw}`, 'CONSOLE', 'exec');

    // Simulate standard Bedrock server command responses
    switch (root) {
      case 'list':
        addLog(`There are ${telemetry.playersOnline}/${properties.maxPlayers} players online: AlexMiner, SteveBuilder, CraftyCrafter, EnderNinja, PixelKnight, RedstoneDave...`, 'BDS', 'info');
        break;
      case 'tps':
        addLog(`Current TPS: 20.00 (avg 14.1ms tick time) | Memory: ${telemetry.ramUsedMb}MB / ${telemetry.ramTotalMb}MB`, 'BDS', 'info');
        break;
      case 'time':
        if (parts[1] === 'set') {
          playXpSound();
          addLog(`Set time to ${parts[2] || 'day'} (Daylight cycle updated)`, 'BDS', 'success');
        } else {
          addLog('Current day time is 6000', 'BDS', 'info');
        }
        break;
      case 'weather':
        playXpSound();
        addLog(`Weather set to ${parts[1] || 'clear'} across all overworld chunks`, 'BDS', 'success');
        break;
      case 'save-all':
        playAnvilSound();
        addLog(`Autosaving worlds to /bedrock/worlds/${properties.levelName}... 1,842 LevelDB records flushed.`, 'BDS', 'success');
        break;
      case 'say':
        addLog(`[SERVER BROADCAST] ${parts.slice(1).join(' ')}`, 'BROADCAST', 'warn');
        break;
      case 'gamemode': {
        const mode = parts[1]?.toUpperCase();
        if (['SURVIVAL', 'CREATIVE', 'ADVENTURE'].includes(mode)) {
          setProperties((p) => ({ ...p, gamemode: mode as 'SURVIVAL' | 'CREATIVE' | 'ADVENTURE' }));
          addLog(`Default game mode set to ${mode}`, 'BDS', 'success');
        } else {
          addLog(`Game mode updated to ${parts[1]} for targeted entities`, 'BDS', 'info');
        }
        break;
      }
      case 'difficulty': {
        const diff = parts[1]?.toUpperCase();
        if (['PEACEFUL', 'EASY', 'NORMAL', 'HARD'].includes(diff)) {
          setProperties((p) => ({ ...p, difficulty: diff as 'PEACEFUL' | 'EASY' | 'NORMAL' | 'HARD' }));
          addLog(`World difficulty set to ${diff}`, 'BDS', 'success');
        }
        break;
      }
      case 'op': {
        const target = parts[1];
        if (target) {
          addOperator(target, target.length === 16 ? target : '2535499120485721', 4);
        } else {
          addLog('Usage: /op <player|xuid>', 'BDS', 'warn');
        }
        break;
      }
      case 'deop': {
        const target = parts[1];
        if (target) {
          const match = operators.find((o) => o.name === target || o.xuid === target);
          if (match) removeOperator(match.xuid);
        }
        break;
      }
      case 'kick': {
        const target = parts[1] || 'all';
        addLog(`Player ${target} kicked from BDS (Reason: Server Admin Directive)`, 'BDS', 'warn');
        break;
      }
      case 'ban': {
        const target = parts[1];
        if (target) banUser(target);
        break;
      }
      case 'stop':
        stopServer();
        break;
      case 'reload':
        restartServer();
        break;
      case 'help':
        addLog('Available commands: /list, /tps, /time set day|night, /weather clear|rain, /save-all, /gamemode, /op, /deop, /kick, /ban, /say, /stop, /reload', 'HELP', 'info');
        break;
      default:
        addLog(`Executed: /${cmd}`, 'BDS', 'info');
        break;
    }
  }, [addLog, telemetry, properties, operators, addOperator, removeOperator, banUser, stopServer, restartServer]);

  // Telemetry tick and uptime increments
  useEffect(() => {
    const timer = setInterval(() => {
      setTelemetry((prev) => {
        if (serverStatus !== 'RUNNING') return prev;
        const jitter = (Math.random() - 0.5) * 0.04;
        const ramJitter = Math.floor((Math.random() - 0.5) * 12);
        const cpuJitter = Math.floor((Math.random() - 0.5) * 3);
        return {
          ...prev,
          tps: Math.min(20.0, Math.max(19.96, +(20.0 + jitter).toFixed(2))),
          ramUsedMb: Math.min(6500, Math.max(3700, prev.ramUsedMb + ramJitter)),
          cpuPercent: Math.min(45, Math.max(12, prev.cpuPercent + cpuJitter)),
          uptimeSeconds: prev.uptimeSeconds + 1,
        };
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [serverStatus]);

  const formatUptime = (totalSeconds: number): string => {
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;
    return `${days}d ${hours}h ${mins}m ${secs}s`;
  };

  return (
    <ServerContext.Provider
      value={{
        currentView,
        setCurrentView,
        serverStatus,
        properties,
        updateProperties,
        operators,
        addOperator,
        removeOperator,
        demoteOperator,
        banUser,
        logs,
        addLog,
        clearLogs,
        executeCommand,
        telemetry,
        pipelineStep,
        isSimulatingCrash,
        setSimulateCrash,
        restartServer,
        stopServer,
        hotReloadDeploy,
        soundMuted,
        toggleSound,
        chatDrawerOpen,
        setChatDrawerOpen,
        copiedNotice,
        copyIp,
        formatUptime,
      }}
    >
      {children}
    </ServerContext.Provider>
  );
}

export function useServer(): ServerContextType {
  const context = useContext(ServerContext);
  if (!context) {
    throw new Error('useServer must be used within a ServerProvider');
  }
  return context;
}
