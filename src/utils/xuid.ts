export type XuidFormat = 'decimal' | 'hexadecimal';

export interface XuidRepresentations {
  decimal: string;
  hexadecimal: string;
}

export type XuidConversionResult =
  | { valid: true; representations: XuidRepresentations }
  | { valid: false; error: string };

const MAX_XUID = 0xffff_ffff_ffff_ffffn;

/** Convert a numeric XUID locally; this validates only its unsigned 64-bit format. */
export function convertXuid(input: string, format: XuidFormat): XuidConversionResult {
  const normalized = input.trim();
  if (!normalized) return { valid: false, error: 'Saisis un XUID à convertir.' };

  let value: bigint;
  if (format === 'decimal') {
    if (!/^\d{1,20}$/.test(normalized)) {
      return { valid: false, error: 'Le format décimal doit contenir de 1 à 20 chiffres.' };
    }
    value = BigInt(normalized);
  } else {
    const digits = normalized.replace(/^0x/i, '');
    if (!/^[\da-fA-F]{1,16}$/.test(digits)) {
      return { valid: false, error: 'Le format hexadécimal accepte jusqu’à 16 chiffres (avec ou sans préfixe 0x).' };
    }
    value = BigInt(`0x${digits}`);
  }

  if (value === 0n) return { valid: false, error: 'Un XUID ne peut pas être égal à zéro.' };
  if (value > MAX_XUID) return { valid: false, error: 'Cette valeur dépasse la plage d’un entier non signé sur 64 bits.' };

  return {
    valid: true,
    representations: {
      decimal: value.toString(10),
      hexadecimal: `0x${value.toString(16).toUpperCase().padStart(16, '0')}`,
    },
  };
}
