import type { CSSProperties } from 'react';
import { useReducedMotion } from 'motion/react';

const KANA = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲンガギグゲゴザジズゼゾダヂヅデドバビブベボパピプペポ';
const GLYPH_COUNT = 960;
const GLYPHS = Array.from({ length: GLYPH_COUNT }, (_, index) => {
  const offset = (index * 17 + Math.floor(index / 9) * 11 + Math.floor(index / 31) * 7) % KANA.length;
  return KANA[offset];
});

export function NetherAmbientBackground() {
  const reduceMotion = useReducedMotion();

  return (
    <div className={`ncraft-rune-field${reduceMotion ? ' ncraft-rune-field--static' : ''}`} aria-hidden="true">
      <div className="ncraft-rune-field__grid">
        {GLYPHS.map((glyph, index) => (
          <span
            key={index}
            className={index % 29 === 4 ? 'ncraft-rune-field__glyph ncraft-rune-field__glyph--magma'
              : index % 37 === 12 ? 'ncraft-rune-field__glyph ncraft-rune-field__glyph--moss'
                : 'ncraft-rune-field__glyph'}
            style={{ '--rune-delay': `${-((index * 13) % 83) / 10}s` } as CSSProperties & { '--rune-delay': string }}
          >
            {glyph}
          </span>
        ))}
      </div>
    </div>
  );
}
