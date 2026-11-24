// SensitiveDataScanner — deterministic LOCAL scan, ported from Android
// core/SensitiveDataScanner.kt (same patterns, same classification, same
// privacy contract). Runs on text BEFORE it is used or sent anywhere.
// Findings carry the TYPE KEY only — never the matched value, not even a part
// of it. The caller displays the type label (via i18n) and asks the user
// "Tetap lanjut" / "Batal"; nothing proceeds until the user chooses.
// No OCR here: the extension has no file/photo upload path (see report);
// the bubble text input is the only text path, and it is scanned on submit.

export type SensitiveType = 'ktp' | 'phone' | 'account' | 'email' | 'password';

export interface SensitiveFinding {
  type: SensitiveType;
}

const TYPE_ORDER: SensitiveType[] = ['ktp', 'phone', 'account', 'email', 'password'];

/** Contiguous 8-16 digits, not part of a longer number. */
const CONTIGUOUS_DIGITS = /(?<!\d)\d{8,16}(?!\d)/g;
/** Grouped digits: 3-4 groups of 3-4 digits, space/dash separated. */
const GROUPED_DIGITS = /\b\d{3,4}(?:[ -]\d{3,4}){2,3}\b/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PASSWORD_KEYWORDS = ['password', 'passphrase', 'kata sandi', 'kata-sandi', 'kata_sandi'];

/** Scan text (+ optional file name). Empty list = nothing found. */
export function scanSensitive(text: string, fileName = ''): SensitiveFinding[] {
  const found = new Set<SensitiveType>();
  scanTextInto(text, found);
  scanFileNameInto(fileName, found);
  return TYPE_ORDER.filter((t) => found.has(t)).map((type) => ({ type }));
}

function scanTextInto(text: string, found: Set<SensitiveType>): void {
  if (!text.trim()) return;
  for (const m of text.matchAll(CONTIGUOUS_DIGITS)) classifyDigits(m[0].replace(/\D/g, ''), found);
  for (const m of text.matchAll(GROUPED_DIGITS)) classifyDigits(m[0].replace(/\D/g, ''), found);
  if (EMAIL.test(text)) found.add('email');
  const lower = text.toLowerCase();
  if (PASSWORD_KEYWORDS.some((k) => lower.includes(k))) found.add('password');
}

function scanFileNameInto(fileName: string, found: Set<SensitiveType>): void {
  if (!fileName.trim()) return;
  const lower = fileName.toLowerCase();
  if (lower.includes('ktp')) found.add('ktp');
  if (lower.includes('rekening')) found.add('account');
  if (lower.includes('email')) found.add('email');
  if (PASSWORD_KEYWORDS.some((k) => lower.includes(k))) found.add('password');
  if (['no_hp', 'no-hp', 'nomor hp', 'nomor-hp', 'nomor_hp', 'nohp'].some((k) => lower.includes(k))) found.add('phone');
  scanTextInto(fileName, found);
}

/**
 * - 16 digits -> KTP (same ambiguity note as Android: a 16-digit number can
 *   also be a card/account number; the user decides on "Tetap lanjut").
 * - Indonesian phone: 08... (10-13 digits) or 628... (11-13 digits).
 * - Other 10-15 digits -> bank account (fail-safe heuristic).
 * - 8-9 digits -> ignored.
 */
function classifyDigits(digits: string, found: Set<SensitiveType>): void {
  if (digits.length === 16) found.add('ktp');
  else if (isIndonesianPhone(digits)) found.add('phone');
  else if (digits.length >= 10 && digits.length <= 15) found.add('account');
}

function isIndonesianPhone(digits: string): boolean {
  if (digits.startsWith('08') && digits.length >= 10 && digits.length <= 13) return true;
  if (digits.startsWith('628') && digits.length >= 11 && digits.length <= 13) return true;
  return false;
}
