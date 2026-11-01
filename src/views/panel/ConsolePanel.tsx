import type { FormEvent, RefObject } from 'react';
import { motion } from 'motion/react';
import { ArrowRight, Terminal } from 'lucide-react';
import { NetherCard } from '../../components/NetherCard.tsx';
import type { ConsoleLog } from '../../types/backend.ts';
import { PanelHeading, StatusPill } from './PanelPrimitives.tsx';

export interface ConsolePanelProps {
  reduceMotion: boolean;
  animatePanelEntry: boolean;
  canOperate: boolean;
  canAdmin: boolean;
  serverRunning: boolean;
  consoleConnected: boolean;
  consoleLogs: ConsoleLog[];
  consoleError: string;
  command: string;
  logViewportRef: RefObject<HTMLDivElement | null>;
  onCommandChange: (value: string) => void;
  onSubmitCommand: (event: FormEvent<HTMLFormElement>) => void;
}

export function ConsolePanel({
  reduceMotion,
  animatePanelEntry,
  canOperate,
  canAdmin,
  serverRunning,
  consoleConnected,
  consoleLogs,
  consoleError,
  command,
  logViewportRef,
  onCommandChange,
  onSubmitCommand,
}: ConsolePanelProps) {
  return (
    <motion.div
      className="ncraft-tab-panel__content"
      initial={reduceMotion || !animatePanelEntry ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduceMotion ? { duration: 0 } : { duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
    >
      <PanelHeading
        variant="console"
        eyebrow="JOURNAL DU SERVEUR"
        title="Console Bedrock"
        description="Logs reçus du processus et commandes envoyées directement à son stdin; aucun shell n’est lancé."
      />
      <NetherCard
        title="Console Bedrock"
        eyebrow="STDIN / STDOUT DU SERVEUR"
        description="Flux temps réel · WebSocket protégé par la session du panneau"
        icon={Terminal}
        accent="moss"
        action={<StatusPill status={consoleConnected ? 'running' : 'starting'} label={consoleConnected ? 'CONNECTÉE' : 'RECONNEXION'} />}
        className="console-card"
      >
        <div ref={logViewportRef} className="nether-terminal" aria-live="polite" aria-label="Journal Bedrock">
          {consoleLogs.length === 0 && <p className="terminal-empty">Aucun log Bedrock reçu. Le serveur est peut-être arrêté.</p>}
          {consoleLogs.map((line) => (
            <div key={line.id} className={`terminal-line terminal-line--${line.level}`}>
              <time dateTime={line.timestamp}>[{new Date(line.timestamp).toLocaleTimeString('fr-FR')}]</time>
              <b>[{line.tag}]</b>
              <span>{line.message}</span>
            </div>
          ))}
        </div>
        {consoleError && <p role="alert" className="inline-error">{consoleError}</p>}
        <form onSubmit={onSubmitCommand} className="console-command-form">
          <label className="console-command-input">
            <Terminal size={16} />
            <input
              value={command}
              onChange={(event) => onCommandChange(event.target.value)}
              maxLength={1000}
              disabled={!canOperate || !serverRunning}
              aria-label="Commande Bedrock"
              placeholder={serverRunning ? 'Commande Bedrock (sans /)' : 'Le serveur doit être en ligne pour envoyer une commande'}
            />
          </label>
          <motion.button type="submit" disabled={!canOperate || !serverRunning || !command.trim()} whileTap={reduceMotion ? undefined : { scale: 0.95 }} className="nether-btn nether-btn--primary">
            <ArrowRight size={16} /> Envoyer
          </motion.button>
        </form>
        <p className="console-footnote">
          Aucun shell n’est lancé : la commande est écrite directement sur stdin de bedrock_server.
          {canOperate && !canAdmin ? ' Les commandes op, deop et allowlist/whitelist sont réservées aux rôles admin et owner.' : ''}
        </p>
      </NetherCard>
    </motion.div>
  );
}

export default ConsolePanel;
