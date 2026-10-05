import type { ViewType } from '../../../types';

/**
 * Inline markup used in the documentation texts:
 *   `code`            → monospace chip
 *   **bold**          → strong
 *   [label](view:xxx) → button that opens that section of the app
 */
export interface DocSection {
  /** Also selects the icon (see HelpView). */
  id: string;
  title: string;
  lead?: string;
  items?: string[];
  /** Two-column reference table (name → description). */
  table?: Array<[string, string]>;
  /** Collapsible questions. */
  faq?: Array<[string, string]>;
  /** Buttons that open a section of the app. */
  links?: Array<{ label: string; view: ViewType }>;
}

export interface HelpText {
  title: string;
  subtitle: string;
  searchPlaceholder: string;
  contents: string;
  nothing: string;
  /** Label of the "open in the main window" hint shown in the separate docs window. */
  inMain: string;
  /** Overview page, previous/next buttons and the "open in a separate window" tooltip. */
  overview: string;
  prev: string;
  next: string;
  openWindow: string;
  quick: Array<{ n: string; title: string; text: string; view?: ViewType }>;
  sections: DocSection[];
}
