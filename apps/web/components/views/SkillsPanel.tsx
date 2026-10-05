'use client';

import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { fetchSkills, setSkillEnabled, type SkillInfo } from '../../lib/api';
import { useT } from '../../lib/i18n';

/** Settings section: toggle the skills the agent may use. */
export function SkillsPanel() {
  const { t } = useT();
  const [skills, setSkills] = useState<SkillInfo[]>([]);

  useEffect(() => {
    void fetchSkills().then(setSkills).catch(() => setSkills([]));
  }, []);

  const toggle = (skill: SkillInfo) => {
    const enabled = !skill.enabled;
    setSkills((prev) => prev.map((s) => (s.name === skill.name ? { ...s, enabled } : s)));
    void setSkillEnabled(skill.name, enabled).catch(() =>
      setSkills((prev) => prev.map((s) => (s.name === skill.name ? { ...s, enabled: !enabled } : s))),
    );
  };

  // built-in skills ship a Russian description; the UI language gets its own text
  const describe = (name: string, source: string, fallback: string): string => {
    if (source !== 'builtin') return fallback;
    const key = `skill.${name}.desc`;
    const text = t(key);
    return text === key ? fallback : text;
  };

  if (!skills.length) return null;
  return (
    <section className="mb-8">
      <h2 className="text-xs uppercase tracking-wider text-[var(--text-muted)] mb-1 flex items-center gap-1.5">
        <Sparkles size={13} /> {t('skills.title')}
      </h2>
      <p className="text-xs text-[var(--text-muted)] mb-3">{t('skills.hint')}</p>
      <ul className="space-y-1.5">
        {skills.map((s) => (
          <li key={s.name} className="flex items-start gap-3 rounded-lg border border-[var(--border)] px-3 py-2">
            <input type="checkbox" className="mt-1" checked={s.enabled} onChange={() => toggle(s)} aria-label={s.name} />
            <div className="min-w-0">
              <div className="text-sm text-[var(--text-primary)]">
                {s.name} <span className="text-[10px] text-[var(--text-muted)]">· {t(`skills.${s.source}`)}</span>
              </div>
              <div className="text-xs text-[var(--text-muted)]">{describe(s.name, s.source, s.description)}</div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
