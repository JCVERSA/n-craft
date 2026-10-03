import { createContext, useCallback, useContext, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { AnimatePresence } from 'motion/react';
import { AlertTriangle, Info, ShieldAlert } from 'lucide-react';
import { NebulaModal, type NebulaModalFocus, type NebulaModalTone } from './NebulaModal.tsx';

export interface DialogOptions {
  title: string;
  message: string;
  eyebrow?: string;
  tone?: NebulaModalTone;
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface PromptDialogOptions extends DialogOptions {
  inputLabel: string;
  placeholder?: string;
  expectedValue?: string;
  helperText?: string;
  maxLength?: number;
}

export interface DialogController {
  alert(options: DialogOptions): Promise<void>;
  confirm(options: DialogOptions): Promise<boolean>;
  prompt(options: PromptDialogOptions): Promise<string | null>;
}

type DialogKind = 'alert' | 'confirm' | 'prompt';
type DialogResult = boolean | string | null;

interface DialogRequest {
  id: number;
  kind: DialogKind;
  options: DialogOptions | PromptDialogOptions;
  resolve: (result: DialogResult) => void;
}

const DialogContext = createContext<DialogController | null>(null);

export function useDialogs(): DialogController {
  const context = useContext(DialogContext);
  if (!context) throw new Error('useDialogs must be used inside DialogProvider.');
  return context;
}

function DialogWindow({ request, onResolve }: { request: DialogRequest; onResolve: (id: number, result: DialogResult) => void }) {
  const [inputValue, setInputValue] = useState('');
  const options = request.options;
  const promptOptions = request.kind === 'prompt' ? options as PromptDialogOptions : null;
  const tone = options.tone ?? 'neutral';
  const messageId = `ncraft-dialog-message-${request.id}`;
  const messageIcon = tone === 'danger' ? ShieldAlert : tone === 'warning' ? AlertTriangle : Info;
  const canSubmit = request.kind !== 'prompt'
    || (promptOptions?.expectedValue !== undefined
      ? inputValue === promptOptions.expectedValue
      : inputValue.trim().length > 0);
  const closeResult = request.kind === 'confirm' ? false : null;
  const finish = (result: DialogResult) => onResolve(request.id, result);
  const paragraphs = options.message.split(/\n{2,}/).filter(Boolean);
  const initialFocus: NebulaModalFocus = request.kind === 'prompt'
    ? 'input'
    : request.kind === 'confirm'
      ? 'cancel'
      : 'primary';

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (request.kind === 'alert') finish(null);
    else if (request.kind === 'confirm') finish(true);
    else if (canSubmit) finish(inputValue);
  };

  return (
    <NebulaModal
      title={options.title}
      eyebrow={options.eyebrow ?? <>CONFIRMATION · <span translate="no">NEBULA CRAFT</span></>}
      icon={messageIcon}
      tone={tone}
      role="alertdialog"
      describedById={messageId}
      initialFocus={initialFocus}
      onClose={() => finish(closeResult)}
    >
      <form className={`ncraft-dialog ncraft-dialog--${request.kind}`} onSubmit={submit}>
        <div id={messageId} className="ncraft-dialog__message">
          {paragraphs.map((paragraph, index) => <p key={`${request.id}-${index}`}>{paragraph}</p>)}
        </div>

        {promptOptions && (
          <div className="ncraft-dialog__field">
            <label htmlFor={`ncraft-dialog-input-${request.id}`}>{promptOptions.inputLabel}</label>
            <input
              id={`ncraft-dialog-input-${request.id}`}
              type="text"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={promptOptions.maxLength ?? (promptOptions.expectedValue?.length || 128)}
              placeholder={promptOptions.placeholder ?? 'Saisis le texte demandé'}
              value={inputValue}
              aria-invalid={promptOptions.expectedValue !== undefined && inputValue.length > 0 && inputValue !== promptOptions.expectedValue}
              onChange={(event) => setInputValue(event.currentTarget.value)}
            />
            <span className="ncraft-dialog__hint">
              {promptOptions.helperText ?? (promptOptions.expectedValue !== undefined
                ? `La saisie doit correspondre exactement à « ${promptOptions.expectedValue} ».`
                : 'Cette saisie reste uniquement dans cette fenêtre.')}
            </span>
          </div>
        )}

        <div className="ncraft-dialog__actions">
          {request.kind !== 'alert' && (
            <button
              type="button"
              className="nether-btn nether-btn--quiet"
              data-modal-cancel="true"
              onClick={() => finish(closeResult)}
            >
              {options.cancelLabel ?? 'Annuler'}
            </button>
          )}
          <button
            type="submit"
            className={`nether-btn ${tone === 'danger' ? 'nether-btn--danger' : 'nether-btn--primary'}`}
            data-modal-primary="true"
            disabled={!canSubmit}
          >
            {request.kind === 'alert' ? 'Compris' : options.confirmLabel ?? (request.kind === 'prompt' ? 'Confirmer' : 'Continuer')}
          </button>
        </div>
      </form>
    </NebulaModal>
  );
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<DialogRequest | null>(null);
  const activeRef = useRef<DialogRequest | null>(null);
  const queueRef = useRef<DialogRequest[]>([]);
  const nextId = useRef(0);

  const request = useCallback((kind: DialogKind, options: DialogOptions | PromptDialogOptions) => new Promise<DialogResult>((resolve) => {
    const dialogRequest: DialogRequest = {
      id: ++nextId.current,
      kind,
      options,
      resolve,
    };
    if (activeRef.current) {
      queueRef.current.push(dialogRequest);
      return;
    }
    activeRef.current = dialogRequest;
    setActive(dialogRequest);
  }), []);

  const resolveRequest = useCallback((id: number, result: DialogResult) => {
    const current = activeRef.current;
    if (!current || current.id !== id) return;
    current.resolve(result);
    const next = queueRef.current.shift() ?? null;
    activeRef.current = next;
    setActive(next);
  }, []);

  const controller = useMemo<DialogController>(() => ({
    alert: async (options) => { await request('alert', options); },
    confirm: async (options) => (await request('confirm', options)) === true,
    prompt: async (options) => {
      const value = await request('prompt', options);
      return typeof value === 'string' ? value : null;
    },
  }), [request]);

  return (
    <DialogContext.Provider value={controller}>
      {children}
      <AnimatePresence mode="wait" initial={false}>
        {active && <DialogWindow key={active.id} request={active} onResolve={resolveRequest} />}
      </AnimatePresence>
    </DialogContext.Provider>
  );
}
