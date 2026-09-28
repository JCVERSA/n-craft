import assert from 'node:assert/strict';
import test from 'node:test';
import { convertXuid } from '../src/utils/xuid.ts';

test('converts a decimal XUID to padded hexadecimal without losing 64-bit precision', () => {
  const result = convertXuid('18446744073709551615', 'decimal');
  assert.deepEqual(result, {
    valid: true,
    representations: {
      decimal: '18446744073709551615',
      hexadecimal: '0xFFFFFFFFFFFFFFFF',
    },
  });
});

test('accepts hexadecimal input with or without a 0x prefix and converts it back to decimal', () => {
  const withPrefix = convertXuid('0xFFFFFFFFFFFFFFFF', 'hexadecimal');
  const withoutPrefix = convertXuid('ffffffffffffffff', 'hexadecimal');
  assert.deepEqual(withPrefix, withoutPrefix);
  assert.deepEqual(withPrefix, {
    valid: true,
    representations: {
      decimal: '18446744073709551615',
      hexadecimal: '0xFFFFFFFFFFFFFFFF',
    },
  });
});

test('normalizes leading zeroes while preserving the numeric value', () => {
  assert.deepEqual(convertXuid('0001', 'decimal'), {
    valid: true,
    representations: { decimal: '1', hexadecimal: '0x0000000000000001' },
  });
  assert.deepEqual(convertXuid('0x0000000000000001', 'hexadecimal'), {
    valid: true,
    representations: { decimal: '1', hexadecimal: '0x0000000000000001' },
  });
});

test('rejects malformed, zero and out-of-range XUID values', () => {
  for (const [input, format] of [
    ['', 'decimal'],
    ['0', 'decimal'],
    ['-1', 'decimal'],
    ['18446744073709551616', 'decimal'],
    ['0x', 'hexadecimal'],
    ['0x10000000000000000', 'hexadecimal'],
    ['not-hex', 'hexadecimal'],
  ] as const) {
    const result = convertXuid(input, format);
    assert.equal(result.valid, false, `${input} (${format}) should be rejected`);
  }
});
