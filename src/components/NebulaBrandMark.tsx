interface NebulaBrandMarkProps {
  alt?: string;
  className?: string;
}

export function NebulaBrandMark({ alt = '', className = '' }: NebulaBrandMarkProps) {
  const classes = ['nebula-brand-mark', className].filter(Boolean).join(' ');

  return (
    <img
      className={classes}
      src="/assets/nebula-craft-mark.svg"
      alt={alt}
      width="256"
      height="256"
      decoding="async"
    />
  );
}
