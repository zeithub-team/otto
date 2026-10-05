/** Keyboard shortcut helpers of the main process (no Electron imports: unit-testable). */

export interface KeyInput { control: boolean; meta: boolean; shift: boolean; alt: boolean; code: string; key: string }

/**
 * Which clipboard command a key press means: Ctrl+C / X / V (also Ctrl+Insert, Shift+Insert,
 * Shift+Delete). Recognised by physical key, by Latin letter and by the Russian layout's letter,
 * so it also works when a driver sends no `code`.
 */
export function clipboardAction(input: KeyInput): 'copy' | 'cut' | 'paste' | null {
  const key = (input.key ?? '').toLowerCase();
  const mod = input.control || input.meta;
  if (input.alt) return null;
  if (mod && !input.shift) {
    if (input.code === 'KeyC' || key === 'c' || key === 'с') return 'copy';
    if (input.code === 'KeyX' || key === 'x' || key === 'ч') return 'cut';
    if (input.code === 'KeyV' || key === 'v' || key === 'м') return 'paste';
    if (key === 'insert') return 'copy';
  }
  if (input.shift && !mod) {
    if (key === 'insert') return 'paste';
    if (key === 'delete') return 'cut';
  }
  return null;
}
