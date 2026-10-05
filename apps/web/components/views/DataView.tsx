'use client';

import type { Project } from '../../types';
import { DataStudio } from '../dbstudio/DataStudio';

/** The Data tab: a DataGrip-style workspace (tree, SQL consoles, editable table grids). */
export function DataView({ project, onOpenServices }: { project: Project | null; onOpenServices?: () => void }) {
  return <DataStudio project={project} onOpenServices={onOpenServices} />;
}
