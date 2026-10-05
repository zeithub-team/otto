'use client';

import { useState, useCallback, useRef } from 'react';
import type { FileInfo } from '../types';
import { fetchFiles, fetchFileContent } from '../lib/api';

export function useFiles(projectId?: number) {
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [selectedFile, setSelectedFileState] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [isFileLoading, setIsFileLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const folderLoadVersion = useRef(0);
  const fileLoadVersion = useRef(0);

  const setSelectedFile = useCallback((filePath: string | null) => {
    fileLoadVersion.current += 1;
    setIsFileLoading(false);
    setError(null);
    setSelectedFileState(filePath);
  }, []);

  const loadFiles = useCallback(async (subPath = '') => {
    if (!projectId) return;
    const requestVersion = ++folderLoadVersion.current;
    try {
      setIsLoading(true);
      setError(null);
      const data = await fetchFiles(projectId, subPath);
      if (requestVersion === folderLoadVersion.current) setFiles(data);
    } catch (e) {
      if (requestVersion === folderLoadVersion.current) {
        setError(e instanceof Error ? e.message : 'Failed to load files');
      }
    } finally {
      if (requestVersion === folderLoadVersion.current) setIsLoading(false);
    }
  }, [projectId]);

  const loadFileContent = useCallback(async (filePath: string): Promise<string | null> => {
    if (!projectId || !filePath) return null;
    const requestVersion = ++fileLoadVersion.current;
    try {
      setIsFileLoading(true);
      setError(null);
      setSelectedFileState(filePath);
      // Drop the previous file's text so a failed load can't show stale content
      setFileContent('');
      const content = await fetchFileContent(projectId, filePath);
      if (requestVersion === fileLoadVersion.current) setFileContent(content);
      return content;
    } catch (e) {
      if (requestVersion === fileLoadVersion.current) {
        setError(e instanceof Error ? e.message : 'Failed to load file');
      }
      return null;
    } finally {
      if (requestVersion === fileLoadVersion.current) setIsFileLoading(false);
    }
  }, [projectId]);

  return {
    files,
    selectedFile,
    fileContent,
    setFileContent,
    isLoading,
    isFileLoading,
    error,
    loadFiles,
    loadFileContent,
    setSelectedFile,
  };
}
