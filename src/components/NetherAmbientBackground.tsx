import { memo, useEffect, useState, type CSSProperties } from 'react';
import { useReducedMotion } from 'motion/react';

const KANA = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲンガギグゲゴザジズゼゾダヂヅデドバビブベボパピプペポ';
const GLYPH_COUNT = 960;
const GLYPHS = Array.from({ length: GLYPH_COUNT }, (_, index) => {
  const offset = (index * 17 + Math.floor(index / 9) * 11 + Math.floor(index / 31) * 7) % KANA.length;
  return KANA[offset];
});

function visibleGlyphCount(): number {
  if (typeof window === 'undefined') return GLYPH_COUNT;

  const columns = Math.max(1, Math.floor((window.innerWidth - 16) / 40));
  const rowHeight = Math.max(34, Math.min(46, window.innerHeight * 0.047));
  const rows = Math.max(1, Math.ceil((window.innerHeight - 10) / rowHeight));
  return Math.min(GLYPH_COUNT, columns * rows);
}

export const NetherAmbientBackground = memo(function NetherAmbientBackground() {
  const reduceMotion = useReducedMotion();
  const [glyphCount, setGlyphCount] = useState(visibleGlyphCount);

  useEffect(() => {
    let resizeFrame = 0;
    const handleResize = () => {
      if (resizeFrame) window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = 0;
        const nextCount = visibleGlyphCount();
        setGlyphCount((currentCount) => currentCount === nextCount ? currentCount : nextCount);
      });
    };

    window.addEventListener('resize', handleResize, { passive: true });
    return () => {
      window.removeEventListener('resize', handleResize);
      if (resizeFrame) window.cancelAnimationFrame(resizeFrame);
    };
  }, []);

  return (
    <div className={`ncraft-rune-field${reduceMotion ? ' ncraft-rune-field--static' : ''}`} aria-hidden="true">
      <div className="ncraft-rune-field__grid">
        {GLYPHS.slice(0, glyphCount).map((glyph, index) => (
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
});
