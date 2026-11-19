/** Money is integer agorot (₪1 = 100 agorot). Conversion is string maths only: no float, ever.
 * Shared by the server and the browser.
 */

export const MAX_OPERATION_AGOROT = 100_000_000n; // ₪1,000,000.00 (API contract D2)

/** JSON wire format for money: a string of integer agorot, no sign, no leading zeros. */
export const AGOROT_PATTERN = /^(0|[1-9][0-9]*)$/;

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EXTENDED_ARABIC_INDIC = '۰۱۲۳۴۵۶۷۸۹';

/** Western digits, '.' as the only decimal mark, no spaces, no ₪. */
function normalizeShekelInput(input: string): string {
  let s = '';
  for (const ch of input.trim()) {
    const a = ARABIC_INDIC.indexOf(ch);
    const e = EXTENDED_ARABIC_INDIC.indexOf(ch);
    if (a >= 0) s += String(a);
    else if (e >= 0) s += String(e);
    else if (ch === '٫' || ch === ',') s += '.';      // Arabic decimal mark, or a comma used as one
    else if (ch === '₪' || ch === ' ' || ch === ' ' || ch === '٬') continue;  // currency, spaces, Arabic thousands mark
    else s += ch;
  }
  return s;
}

export class MoneyInputError extends Error {}

/** "100.70" → 10070n. Also accepts "١٠٠٫٧٠", "100,7", "₪ 100". Rejects more than 2 decimals, signs, letters. */
export function parseShekelsToAgorot(input: string): bigint {
  const s = normalizeShekelInput(input);
  const m = /^([0-9]+)(?:\.([0-9]{1,2}))?$/.exec(s);
  if (!m) throw new MoneyInputError(`not a shekel amount: "${input}"`);
  const shekels = BigInt(m[1]!);
  const agorot = BigInt((m[2] ?? '').padEnd(2, '0'));
  return shekels * 100n + agorot;
}

/** Parse the JSON wire string. Throws on anything but integer agorot. */
export function parseAgorot(wire: string): bigint {
  if (typeof wire !== 'string' || !AGOROT_PATTERN.test(wire)) throw new MoneyInputError(`not integer agorot: "${wire}"`);
  return BigInt(wire);
}

/** 10070n → "100.70". For display; add "₪" and grouping in the UI. */
export function formatAgorot(agorot: bigint): string {
  const negative = agorot < 0n;
  const abs = negative ? -agorot : agorot;
  const shekels = abs / 100n;
  const rest = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${shekels}.${rest}`;
}
