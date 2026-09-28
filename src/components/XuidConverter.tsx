import { useState } from 'react';
import { Copy } from 'lucide-react';
import { convertXuid, type XuidFormat } from '../utils/xuid.ts';

interface XuidConverterProps {
  onCopy: (value: string, label: string) => void | Promise<void>;
}

export function XuidConverter({ onCopy }: XuidConverterProps) {
  const [format, setFormat] = useState<XuidFormat>('decimal');
  const [input, setInput] = useState('');
  const result = input.trim() ? convertXuid(input, format) : null;

  return (
    <details className="xuid-converter">
      <summary className="xuid-converter__summary">
        <span>Convertisseur XUID local</span>
        <small>Décimal ↔ hexadécimal</small>
      </summary>
      <div className="xuid-converter__body">
        <p className="xuid-converter__note">
          Conversion effectuée dans ce navigateur. Elle ne recherche pas le compte et ne confirme ni l’existence ni le propriétaire du XUID.
        </p>
        <div className="xuid-converter__input-grid">
          <label className="nether-field" htmlFor="xuid-converter-format">
            <span>Format saisi</span>
            <select
              id="xuid-converter-format"
              className="nether-input"
              value={format}
              onChange={(event) => setFormat(event.target.value as XuidFormat)}
            >
              <option value="decimal">Décimal</option>
              <option value="hexadecimal">Hexadécimal</option>
            </select>
          </label>
          <label className="nether-field" htmlFor="xuid-converter-input">
            <span>Valeur</span>
            <input
              id="xuid-converter-input"
              className="nether-input"
              type="text"
              inputMode={format === 'decimal' ? 'numeric' : 'text'}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              maxLength={64}
              placeholder={format === 'decimal' ? 'Ex. 2535412894129841' : 'Ex. 0x0000000000000001'}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              aria-describedby="xuid-converter-help"
              aria-invalid={result?.valid === false}
            />
          </label>
        </div>
        <p id="xuid-converter-help" className="xuid-converter__note">
          Plage vérifiée : entier non nul sur 64 bits. Cette vérification porte uniquement sur le format.
        </p>
        {result?.valid ? (
          <div className="xuid-converter__results" aria-live="polite">
            <div className="xuid-converter__result">
              <span>Décimal</span>
              <code>{result.representations.decimal}</code>
              <button
                type="button"
                className="icon-button"
                aria-label="Copier le XUID décimal"
                onClick={() => { void onCopy(result.representations.decimal, 'XUID décimal'); }}
              >
                <Copy size={15} />
              </button>
            </div>
            <div className="xuid-converter__result">
              <span>Hexadécimal</span>
              <code>{result.representations.hexadecimal}</code>
              <button
                type="button"
                className="icon-button"
                aria-label="Copier le XUID hexadécimal"
                onClick={() => { void onCopy(result.representations.hexadecimal, 'XUID hexadécimal'); }}
              >
                <Copy size={15} />
              </button>
            </div>
          </div>
        ) : result ? (
          <p className="inline-error" role="alert">{result.error}</p>
        ) : null}
      </div>
    </details>
  );
}
