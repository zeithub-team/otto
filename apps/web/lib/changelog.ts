/**
 * Release notes shown in Settings → About, newest first. Every release adds an
 * entry here and keeps the old ones — the GitHub release text is made from it.
 */
export interface ChangelogEntry {
  version: string;
  date: string; // YYYY-MM-DD
  items: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.1.7',
    date: '2026-10-05',
    items: [
      'The installer finds an installed Otto and offers to update it in place, skipping the setup pages',
      'An update keeps settings, language and theme (setup.json is no longer rewritten)',
    ],
  },
  {
    version: '0.1.6',
    date: '2026-10-05',
    items: [
      'Otto checks GitHub for a new version at startup and once a day and offers to download it',
      'Settings → About shows the real version and the list of changes of every release',
    ],
  },
  {
    version: '0.1.5',
    date: '2026-10-05',
    items: [
      'Model switch notice is one line: the first model, how many were skipped and the current one',
      'Two failures in a row at one provider skip the rest of its models',
      'Cloud models run commands with run_command instead of pasting them into the chat',
      'Short shell commands in an answer are no longer replaced with the "code instead of write_file" marker',
    ],
  },
  {
    version: '0.1.4',
    date: '2026-10-03',
    items: [
      'Preview tabs: every page or address opens in its own tab',
      'Browser check after the model finishes a site: Otto shows the model what looks off at desktop and phone width',
      'New local models in the catalog: Qwen3.6, Qwen3.5, Gemma 4, Qwen3-VL, DeepSeek R1, GPT-OSS, Devstral',
      'Guided mode: small local models write files step by step instead of pasting code',
      'Automatic fallback to the next provider when one is down or out of quota, ending with a local model',
      'Step-by-step builder for multi-page sites',
      'The model can drive Otto: preview, theme, language, tasks, settings, SSH (risky actions ask first)',
      'Tabby can replace the built-in terminal; Agents and Services counters in the header',
      'New free providers: NVIDIA, Cohere, Z.ai, Cloudflare',
      'Fixed: badges overlapping the model name in Models; the installer theme is applied',
    ],
  },
];
