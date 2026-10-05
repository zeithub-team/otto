'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { Project } from '../types';
import { fetchProjects, createProject, deleteProject, type NewProjectOptions } from '../lib/api';

export function useProjects(accountId = 0) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const projectsRef = useRef<Project[]>([]);

  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  const loadProjects = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const data = await fetchProjects(accountId);
      setProjects(data);
      // Select the first project of the active account (or clear when empty).
      setSelectedProject((prev) => {
        if (prev && data.some((p) => p.id === prev.id)) return prev;
        return data[0] ?? null;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load projects');
    } finally {
      setIsLoading(false);
    }
  }, [accountId]);

  const addProject = useCallback(async (name: string, folder?: string, options?: NewProjectOptions) => {
    try {
      setError(null);
      const project = await createProject(name, folder, accountId, options);
      // a project filed under another organization is not part of this list
      if ((options?.account_id ?? accountId) === accountId) {
        setProjects((prev) => [...prev, project]);
        setSelectedProject(project);
      }
      return project;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to create project';
      setError(msg);
      throw e;
    }
  }, [accountId]);

  const removeProject = useCallback(async (projectId: number) => {
    try {
      await deleteProject(String(projectId));
      setProjects((prev) => prev.filter((p) => p.id !== projectId));
      setSelectedProject((prev) => {
        if (prev?.id === projectId) {
          const remaining = projectsRef.current.filter((p) => p.id !== projectId);
          return remaining.length > 0 ? remaining[0] : null;
        }
        return prev;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete project');
    }
  }, []);

  /** Reflect a project already saved by the caller (rename/rebind) in the lists. */
  const applyProjectUpdate = useCallback((updated: Project) => {
    setProjects((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    setSelectedProject((prev) => (prev?.id === updated.id ? updated : prev));
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  return {
    projects,
    selectedProject,
    setSelectedProject,
    isLoading,
    error,
    loadProjects,
    addProject,
    removeProject,
    applyProjectUpdate,
  };
}
