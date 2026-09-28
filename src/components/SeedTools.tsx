import { Copy, ExternalLink } from 'lucide-react';

interface SeedToolsProps {
  seed: string;
  copyLabel?: string;
  onCopy: (seed: string) => void | Promise<void>;
}

const SEED_MAP_URL = 'https://mcseedview.com/';

export function SeedTools({ seed, copyLabel = 'Copier la seed', onCopy }: SeedToolsProps) {
  if (!seed.trim()) return null;

  return (
    <div className="seed-tools">
      <div className="seed-tools__actions">
        <button
          type="button"
          className="nether-btn nether-btn--quiet nether-btn--tiny"
          aria-label={copyLabel}
          onClick={() => { void onCopy(seed); }}
        >
          <Copy size={14} /> Copier
        </button>
        <a
          className="nether-btn nether-btn--quiet nether-btn--tiny"
          href={SEED_MAP_URL}
          target="_blank"
          rel="noopener noreferrer"
          referrerPolicy="no-referrer"
          aria-label="Ouvrir MC Seed View dans un nouvel onglet, sans transmettre la seed"
        >
          <ExternalLink size={14} /> MC Seed View
        </a>
      </div>
      <small className="seed-tools__note">
        Site tiers : ce lien ne transmet pas la seed; colle-la toi-même. Vérifie la compatibilité et la précision pour ta version Bedrock.
      </small>
    </div>
  );
}
