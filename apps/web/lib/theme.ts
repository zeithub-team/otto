/** Color schemes selectable in Settings (applied via <html data-theme>). */
export type ThemeId =
  | 'emerald' | 'ocean' | 'violet' | 'amber' | 'light'
  | 'dracula' | 'nord' | 'tokyo' | 'onedark' | 'gruvbox' | 'catppuccin' | 'solarized' | 'solarized-light';

export interface ThemeOption {
  id: ThemeId;
  name: string;
  /** Swatch colors for the picker: [background, accent]. */
  swatch: [string, string];
}

export const THEMES: ThemeOption[] = [
  { id: 'emerald', name: 'Emerald', swatch: ['#0d1117', '#00f5a0'] },
  { id: 'ocean', name: 'Ocean', swatch: ['#0d1424', '#38bdf8'] },
  { id: 'violet', name: 'Violet', swatch: ['#140d1f', '#c084fc'] },
  { id: 'amber', name: 'Amber', swatch: ['#17130c', '#fbbf24'] },
  { id: 'light', name: 'Light', swatch: ['#f4f6f8', '#0a7d59'] },
  { id: 'dracula', name: 'Dracula', swatch: ['#282a36', '#bd93f9'] },
  { id: 'nord', name: 'Nord', swatch: ['#2e3440', '#88c0d0'] },
  { id: 'tokyo', name: 'Tokyo Night', swatch: ['#1a1b26', '#7aa2f7'] },
  { id: 'onedark', name: 'One Dark', swatch: ['#282c34', '#61afef'] },
  { id: 'gruvbox', name: 'Gruvbox', swatch: ['#282828', '#fabd2f'] },
  { id: 'catppuccin', name: 'Catppuccin', swatch: ['#1e1e2e', '#cba6f7'] },
  { id: 'solarized', name: 'Solarized Dark', swatch: ['#002b36', '#2aa198'] },
  { id: 'solarized-light', name: 'Solarized Light', swatch: ['#fdf6e3', '#1f6fa8'] },
];

const STORAGE_KEY = 'otto-theme';

export function getTheme(): ThemeId {
  if (typeof window === 'undefined') return 'emerald';
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY) as ThemeId | null;
    if (saved && THEMES.some((t) => t.id === saved)) return saved;
  } catch { /* ignore */ }
  return 'emerald';
}

/** Set <html data-theme> ('emerald' is the default → no attribute). */
export function applyTheme(id: ThemeId): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (id === 'emerald') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', id);
}

export function setTheme(id: ThemeId): void {
  applyTheme(id);
  try { window.localStorage.setItem(STORAGE_KEY, id); } catch { /* ignore */ }
}
