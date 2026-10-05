'use client';

import { useEffect } from 'react';
import { HelpView } from './HelpView';
import { requestMainView } from '../../lib/docsWindow';
import { useT } from '../../lib/i18n';

/** The documentation on its own: opened in a separate window from the sidebar. */
export function DocsWindow() {
  const { t } = useT();
  useEffect(() => {
    document.title = `zeithub.otto — ${t('sidebar.docs')}`;
  }, [t]);
  return (
    <div className="flex h-screen flex-col bg-[var(--bg-primary)]">
      <HelpView standalone onNavigate={requestMainView} />
    </div>
  );
}
