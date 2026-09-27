import { useState, useRef, useEffect, KeyboardEvent } from 'react';
import { motion } from 'motion/react';
import { useServer } from '../context/ServerContext.tsx';

interface TerminalLogsProps {
  title?: string;
  heightClass?: string;
  variant?: 'standard' | 'crt';
}

export function TerminalLogs({
  title = 'BEDROCK DEDICATED LOGS',
  heightClass = 'h-64',
  variant = 'standard',
}: TerminalLogsProps) {
  const { logs, clearLogs, executeCommand } = useServer();
  const [inputVal, setInputVal] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState<number>(-1);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  const handleSend = () => {
    const trimmed = inputVal.trim();
    if (!trimmed) return;
    executeCommand(trimmed);
    setHistory((prev) => [...prev, trimmed]);
    setHistoryIdx(-1);
    setInputVal('');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleSend();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length > 0) {
        const nextIdx = historyIdx === -1 ? history.length - 1 : Math.max(0, historyIdx - 1);
        setHistoryIdx(nextIdx);
        setInputVal(history[nextIdx]);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIdx !== -1) {
        const nextIdx = historyIdx + 1;
        if (nextIdx < history.length) {
          setHistoryIdx(nextIdx);
          setInputVal(history[nextIdx]);
        } else {
          setHistoryIdx(-1);
          setInputVal('');
        }
      }
    }
  };

  return (
    <div
      className={`w-full ${
        variant === 'crt' ? 'crt-screen p-3' : 'bg-[#1f2020] mc-bevel p-3 sm:p-4'
      } flex flex-col gap-2 relative`}
    >
      {/* Terminal Title Bar */}
      <div className="flex items-center justify-between pb-2 border-b-2 border-[#0e0e0e] z-30 shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 bg-[#0e0e0e] mc-inset flex items-center justify-center text-[#97d85d]">
            <span className="material-symbols-outlined text-[16px]">terminal</span>
          </div>
          <span
            className={`font-pixel text-xs sm:text-sm font-bold ${
              variant === 'crt' ? 'text-[#97d85d] crt-glow' : 'text-[#e4e2e2]'
            }`}
          >
            {title}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-jb text-[11px] text-[#97d85d] flex items-center gap-1.5 hidden sm:flex">
            <span className="w-2 h-2 bg-[#97d85d] mc-bevel animate-ping" />
            <span>STREAMING BDS STDOUT</span>
          </span>
          <motion.button
            type="button"
            whileTap={{ scale: 0.92 }}
            onClick={clearLogs}
            className="mc-stone-btn bg-[#1b1c1c] px-2 py-0.5 font-jb text-[10px] text-[#c2c9b5] hover:text-white"
          >
            [CLEAR]
          </motion.button>
        </div>
      </div>

      {/* Terminal Logs Viewport */}
      <div
        ref={scrollRef}
        className={`w-full ${heightClass} bg-[#0e0e0e] mc-inset p-3 overflow-y-auto flex flex-col gap-1 font-jb text-xs select-text leading-relaxed z-30`}
      >
        {logs.map((log) => {
          let color = 'text-[#c2c9b5]';
          if (log.level === 'warn') color = 'text-[#ffb3ae]';
          if (log.level === 'error') color = 'text-[#ff8782] font-bold';
          if (log.level === 'success') color = 'text-[#97d85d] font-bold';
          if (log.level === 'exec') color = 'text-[#dfc740] font-bold';

          return (
            <div key={log.id} className={`${color} break-all`}>
              <span className="text-[#8c9380] font-mono select-none">[{log.timestamp}] </span>
              <span className="text-[#dfc740] font-bold">[{log.tag}] </span>
              <span>{log.message}</span>
            </div>
          );
        })}
      </div>

      {/* Quick Macros Row */}
      <div className="flex flex-wrap items-center gap-1.5 pt-1 z-30">
        <span className="font-jb text-[10px] text-[#c2c9b5] uppercase mr-1">QUICK MACROS:</span>
        {[
          { label: '/list', color: 'text-[#dfc740]' },
          { label: '/time set day', color: 'text-[#e4e2e2]' },
          { label: '/weather clear', color: 'text-[#e4e2e2]' },
          { label: '/save-all', color: 'text-[#97d85d]' },
          { label: '/tps', color: 'text-[#dfc740]' },
        ].map((macro) => (
          <motion.button
            key={macro.label}
            type="button"
            whileTap={{ scale: 0.94 }}
            onClick={() => executeCommand(macro.label)}
            className={`mc-stone-btn bg-[#2a2a2a] px-2 py-0.5 font-jb text-[11px] ${macro.color} hover:bg-[#343535]`}
          >
            {macro.label}
          </motion.button>
        ))}
      </div>

      {/* Terminal Input Bar */}
      <div className="flex items-center gap-2 mt-1 z-30">
        <div className="mc-inset bg-[#0e0e0e] p-1.5 flex-1 flex items-center gap-1">
          <span className="font-pixel text-xs text-[#97d85d] px-1 select-none font-bold">/</span>
          <input
            type="text"
            value={inputVal}
            onChange={(e) => setInputVal(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type server command (e.g. list, op, say, gamemode, kick)..."
            className="w-full bg-transparent font-jb text-xs text-[#e4e2e2] outline-none placeholder:text-[#8c9380]"
          />
        </div>
        <motion.button
          type="button"
          whileTap={{ scale: 0.92 }}
          onClick={handleSend}
          className="mc-bevel bg-[#97d85d] px-3 sm:px-4 py-1.5 font-pixel text-[10px] text-[#1b3700] font-bold hover:bg-[#b2f575] flex items-center gap-1 cursor-pointer"
        >
          <span>SEND</span>
          <span className="material-symbols-outlined text-[14px]">send</span>
        </motion.button>
      </div>
    </div>
  );
}

