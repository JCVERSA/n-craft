interface NebulaBrandMarkProps {
  alt?: string;
  className?: string;
}

export function NebulaBrandMark({ alt = '', className = '' }: NebulaBrandMarkProps) {
  const classes = ['nebula-brand-mark', className].filter(Boolean).join(' ');

  return (
    <picture className={classes}>
      <source
        media="(prefers-reduced-motion: reduce)"
        srcSet="/assets/noto-logo-mark-static.svg"
      />
      <img
        src="/assets/noto-logo-mark.svg"
        alt={alt}
        width="660"
        height="660"
        decoding="async"
      />
    </picture>
  );
}
