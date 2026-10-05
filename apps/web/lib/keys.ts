'use client';

/**
 * Layout- and driver-independent hotkey match.
 *
 * `e.code` (physical key) is layout-independent but can be empty when keys
 * arrive through RDP/KVM layers or quirky drivers; `e.key` works there but
 * depends on layout. Accept either: the physical code or the logical letter
 * in English or Russian layout.
 *
 *   matchHotkey(e, 'KeyO', 'o', 'щ')  // Ctrl+Shift+O / Ctrl+Shift+Щ
 */
export function matchHotkey(
  e: { code?: string; key?: string },
  code: string,
  ...keys: string[]
): boolean {
  if (e.code === code) return true;
  const k = (e.key ?? '').toLowerCase();
  return k !== '' && keys.includes(k);
}
