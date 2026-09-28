import { DialogProvider } from './components/DialogProvider.tsx';
import { LivePanelView } from './views/LivePanelView.tsx';

export default function App() {
  return (
    <DialogProvider>
      <LivePanelView />
    </DialogProvider>
  );
}
