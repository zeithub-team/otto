/** Vault encryption: master password → AES-GCM 256 key via PBKDF2 (250 000 rounds), the same scheme as the zeithub.coverty extension. */

const enc = new TextEncoder();
const dec = new TextDecoder();
const ITERATIONS = 250_000;

export interface SealedVault { salt: string; iv: string; data: string }

export const toB64 = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
export const fromB64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

async function derive(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt as BufferSource, iterations: ITERATIONS, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function newVaultKey(password: string): Promise<{ salt: string; key: CryptoKey }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: toB64(salt), key: await derive(password, salt) };
}

export const keyFromSalt = (password: string, saltB64: string): Promise<CryptoKey> => derive(password, fromB64(saltB64));

export async function seal(key: CryptoKey, salt: string, value: unknown): Promise<SealedVault> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, enc.encode(JSON.stringify(value)));
  return { salt, iv: toB64(iv), data: toB64(cipher) };
}

/** Throws when the password (key) is wrong: AES-GCM authenticates the data. */
export async function unseal<T>(key: CryptoKey, vault: SealedVault): Promise<T> {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(vault.iv) as BufferSource }, key, fromB64(vault.data) as BufferSource);
  return JSON.parse(dec.decode(plain)) as T;
}

/** A random password from the chosen character sets (rejection sampling: no modulo bias). */
export function generatePassword(length: number, sets: { lower: boolean; upper: boolean; digits: boolean; symbols: boolean }): string {
  const pools = [
    sets.lower ? 'abcdefghijkmnopqrstuvwxyz' : '',
    sets.upper ? 'ABCDEFGHJKLMNPQRSTUVWXYZ' : '',
    sets.digits ? '23456789' : '',
    sets.symbols ? '!@#$%^&*-_=+?' : '',
  ].filter(Boolean);
  if (pools.length === 0) return '';
  const all = pools.join('');
  const pick = (chars: string): string => {
    const limit = Math.floor(0x100000000 / chars.length) * chars.length;
    const buf = new Uint32Array(1);
    do { crypto.getRandomValues(buf); } while (buf[0] >= limit);
    return chars[buf[0] % chars.length];
  };
  const out = pools.map(pick); // at least one of every chosen kind
  while (out.length < Math.max(length, pools.length)) out.push(pick(all));
  for (let i = out.length - 1; i > 0; i--) { // shuffle
    const j = Math.floor((crypto.getRandomValues(new Uint32Array(1))[0] / 0x100000000) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join('');
}
