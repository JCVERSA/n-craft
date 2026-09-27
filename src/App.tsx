import { useEffect } from 'react';
import { ServerProvider, useServer } from './context/ServerContext.tsx';
import { Header } from './components/Header.tsx';
import { HotbarDock } from './components/HotbarDock.tsx';
import { DashboardView } from './views/DashboardView.tsx';
import { OperatorAuthView } from './views/OperatorAuthView.tsx';
import { ChestMatrixView } from './views/ChestMatrixView.tsx';
import { NodePipelineView } from './views/NodePipelineView.tsx';
import { F3TelemetryView } from './views/F3TelemetryView.tsx';
import { playClickSound } from './utils/audio.ts';

function AppContent() {
  const {
    currentView,
    setChatDrawerOpen,
    executeCommand,
    hotReloadDeploy,
    updateProperties,
    properties,
    addLog,
  } = useServer();

  // Global hotkeys listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeTag = (document.activeElement?.tagName || '').toLowerCase();
      if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select') {
        return;
      }

      // 'T' toggles multiplayer chat drawer
      if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        playClickSound();
        setChatDrawerOpen((prev) => !prev);
        return;
      }

      // Number keys 1-9 for Hotbar
      if (['1', '2', '3', '4', '5', '6', '7', '8', '9'].includes(e.key)) {
        e.preventDefault();
        const slot = parseInt(e.key, 10);
        switch (slot) {
          case 1:
            executeCommand('/tps');
            break;
          case 2:
            executeCommand('/list');
            break;
          case 3:
            executeCommand('/time set day');
            break;
          case 4:
            executeCommand('/weather clear');
            break;
          case 5:
            executeCommand('/save-all');
            break;
          case 6:
            hotReloadDeploy();
            break;
          case 7: {
            const next = !properties.whitelistEnforced;
            updateProperties({ whitelistEnforced: next });
            addLog(
              next ? 'Whitelist is now ENFORCED.' : 'Whitelist is now PUBLIC.',
              'SECURITY',
              next ? 'warn' : 'info'
            );
            break;
          }
          case 8:
            addLog(`Level backup created: /backups/${properties.levelName}.mcworld (642 MB)`, 'BACKUP', 'success');
            break;
          case 9:
            executeCommand('/stop');
            break;
          default:
            break;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setChatDrawerOpen, executeCommand, hotReloadDeploy, properties, updateProperties, addLog]);

  return (
    <div className="min-h-screen bg-[#131314] text-[#e4e2e2] flex flex-col font-space">
      <Header />

      <div className="flex-1 w-full px-2 sm:px-4 pt-3">
        {currentView === 'dashboard' && <DashboardView />}
        {currentView === 'operator-auth' && <OperatorAuthView />}
        {currentView === 'chest-matrix' && <ChestMatrixView />}
        {currentView === 'node-pipeline' && <NodePipelineView />}
        {currentView === 'f3-telemetry' && <F3TelemetryView />}
      </div>

      <HotbarDock />
    </div>
  );
}

export default function App() {
  return (
    <ServerProvider>
      <AppContent />
    </ServerProvider>
  );
}
