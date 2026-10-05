'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Paperclip, Square, ArrowUp, FileText, AlertTriangle, X,
  Wrench, Globe, ChevronDown, ChevronUp, ListPlus, Cpu, RefreshCw,
} from 'lucide-react';
import { extractDocument, fetchModels, fetchAppSettings } from '../../lib/api';
import { DEFAULT_PARAMS, displayModel, loadParams, pickDefaultModel, pushRecent, saveParams, type ModelParams } from '../../lib/models';
import { ModelPicker } from './ModelPicker';
import type { SendOptions } from '../../types';
import { SubscriptionLimitsBadge } from '../views/ClaudeCliAuth';
import { SkillsChip } from './SkillsChip';
import { useT } from '../../lib/i18n';
import type { UsageInfo } from '../../hooks/useChat';
import { ContextMeter } from './ContextMeter';
import { hasOsFiles } from '../../lib/dropfiles';
import { isBulkyText, nameForPastedText } from '../../lib/attachments';
import { setProjectModel, syncGlobalModel, type ModelChanged } from '../../lib/modelStore';

export interface Attachment {
  name: string;
  content: string;   // extracted text content
  image?: string;    // base64 (without data-url prefix) for images
  thumb?: string;    // data-url for preview
  pending?: boolean; // still being parsed/uploaded
}

export interface ComposerSendOptions extends SendOptions {
  queue?: boolean;
}

interface ComposerProps {
  onSend: (message: string, images?: string[], options?: ComposerSendOptions) => void;
  onStop: () => void;
  disabled?: boolean;
  isProcessing?: boolean;
  queuedCount?: number;
  usage?: UsageInfo | null;
  placeholder?: string;
  /** The project whose model is shown and changed here. */
  projectId?: number;
}

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];

const TEXT_EXT = [
  'txt', 'py', 'js', 'ts', 'tsx', 'jsx', 'json', 'md', 'html', 'css', 'scss', 'less',
  'yaml', 'yml', 'toml', 'cfg', 'ini', 'env', 'xml', 'sql', 'sh', 'bat', 'ps1',
  'c', 'cpp', 'h', 'hpp', 'java', 'go', 'rs', 'rb', 'php', 'swift', 'kt',
  'vue', 'svelte', 'astro', 'mjs', 'cjs', 'csv', 'log', 'conf', 'properties',
  'gradle', 'makefile', 'cmake', 'lua', 'dart', 'graphql', 'proto', 'r', 'pl',
];

// Parsed server-side by /api/files/extract
const DOC_EXT = ['pdf', 'docx', 'xlsx', 'tsv', 'rtf'];

/**
 * What was typed (and attached) but not sent yet, per project. The form is unmounted when another tab
 * (Preview, Files…) is shown, and this keeps the draft for when it comes back — and, for the text,
 * across a restart.
 */
const drafts = new Map<string, { value: string; attachments: Attachment[] }>();
const draftKey = (projectId?: number): string => `otto-draft:${projectId ?? 0}`;
function readDraftText(key: string): string {
  try { return typeof window === 'undefined' ? '' : window.localStorage.getItem(key) ?? ''; } catch { return ''; }
}

export function Composer({ onSend, onStop, disabled, isProcessing, queuedCount = 0, usage, placeholder, projectId }: ComposerProps) {
  const { t } = useT();
  const dKey = draftKey(projectId);
  const [value, setValue] = useState(() => drafts.get(dKey)?.value ?? readDraftText(dKey));
  const [collapsed, setCollapsed] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>(() => drafts.get(dKey)?.attachments.filter((a) => !a.pending) ?? []);
  useEffect(() => {
    drafts.set(dKey, { value, attachments });
    try { if (value) window.localStorage.setItem(dKey, value); else window.localStorage.removeItem(dKey); } catch { /* storage unavailable */ }
  }, [dKey, value, attachments]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Composer options: model + capability toggles
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState<string | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [params, setParams] = useState<ModelParams>(DEFAULT_PARAMS);
  useEffect(() => setParams(loadParams()), []);
  // the server moved the run to another cloud model after a failure — follow it (and keep it for the project)
  useEffect(() => {
    const follow = (e: Event) => {
      const next = (e as CustomEvent<{ model?: string }>).detail?.model;
      if (next) { setModel(next); setProjectModel(projectId, next); }
    };
    window.addEventListener('otto:model-switch', follow);
    return () => window.removeEventListener('otto:model-switch', follow);
  }, [projectId]);
  // the model was changed elsewhere (Agents tab): the same project follows
  useEffect(() => {
    const changed = (e: Event) => {
      const d = (e as CustomEvent<ModelChanged>).detail;
      if (d?.model && (d.projectId ?? null) === (projectId ?? null)) setModel(d.model);
    };
    window.addEventListener('otto:model-changed', changed);
    return () => window.removeEventListener('otto:model-changed', changed);
  }, [projectId]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [toolsOn, setToolsOn] = useState(true);
  const [webOn, setWebOn] = useState(true);
  // the Web toggle starts from the default chosen in Settings → Agent
  useEffect(() => {
    void fetchAppSettings().then((cfg) => { if (typeof cfg.values['agent.web'] === 'boolean') setWebOn(cfg.values['agent.web']); }).catch(() => undefined);
  }, []);
  const [sendMenuOpen, setSendMenuOpen] = useState(false);
  const modelRef = useRef<HTMLDivElement>(null);
  const sendMenuRef = useRef<HTMLDivElement>(null);

  const refreshModels = useCallback(async () => {
    setModelsLoading(true);
    try {
      const list = await fetchModels();
      setModels(list);
      // the project's own choice wins; a model that vanished from the list falls back to a default
      const saved = syncGlobalModel(projectId);
      setModel((prev) => {
        if (saved && list.includes(saved)) return saved;
        if (prev && list.includes(prev)) return prev;
        return pickDefaultModel(list);
      });
    } finally {
      setModelsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refreshModels();
    const timer = window.setInterval(() => void refreshModels(), 15000);
    // a subscription (Claude / Codex) was switched on or signed in: its models appear right away
    const onSubscription = () => void refreshModels();
    window.addEventListener('otto:subscription-auth', onSubscription);
    return () => { window.clearInterval(timer); window.removeEventListener('otto:subscription-auth', onSubscription); };
  }, [refreshModels]);

  // Close dropdowns on outside click / Escape
  useEffect(() => {
    if (!modelOpen && !sendMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (modelRef.current && !modelRef.current.contains(t)) setModelOpen(false);
      if (sendMenuRef.current && !sendMenuRef.current.contains(t)) setSendMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setModelOpen(false); setSendMenuOpen(false); }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [modelOpen, sendMenuOpen]);

  // Ctrl+K is owned by the command palette (see CommandPalette.tsx)

  const handleSend = useCallback((queue = false) => {
    const hasAttachment = attachments.some((a) => a.image || a.content);
    const trimmed = value.trim() || (hasAttachment ? t('cp.seeAttachment') : '');
    if (!trimmed || disabled) return;
    // wait for pending document parsing
    if (attachments.some((a) => a.pending)) return;

    const textFiles = attachments.filter((a) => a.content && !a.image);
    const images = attachments.filter((a) => a.image).map((a) => a.image!);

    let fullMessage = trimmed;
    if (textFiles.length > 0) {
      const sections = textFiles.map(
        (a) => `\n\n--- File: ${a.name} ---\n\`\`\`\n${a.content}\n\`\`\``
      );
      fullMessage = trimmed + sections.join('');
    }

    onSend(fullMessage, images.length > 0 ? images : undefined, {
      // always the model the user picked: pictures included (a cloud model reads them itself, a local
      // one that cannot is swapped for an installed vision model by the server)
      model: model ?? undefined,
      useTools: toolsOn,
      useWeb: webOn,
      effort: params.effort === 'auto' ? undefined : params.effort,
      numCtx: params.numCtx ?? undefined,
      temperature: params.temperature ?? undefined,
      queue,
    });
    setValue('');
    setAttachments([]);
    setSendMenuOpen(false);
  }, [value, disabled, attachments, model, params, toolsOn, webOn, onSend, t]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    addFiles(Array.from(files));
    e.target.value = '';
  };

  /** Attach files chosen with the clip button, dropped onto the form, or pasted. */
  const addFiles = (files: File[]) => {
    files.forEach((file) => {
      const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
      const isImage = IMAGE_EXT.includes(ext) || file.type.startsWith('image/');
      const isText = TEXT_EXT.includes(ext) || file.type.startsWith('text/') || file.type === 'application/json';
      const isDoc = DOC_EXT.includes(ext);

      if (isImage) {
        if (file.size > 5_000_000) {
          setAttachments((prev) => [...prev, { name: t('cp.big5', { name: file.name }), content: '' }]);
          return;
        }
        const reader = new FileReader();
        reader.onload = (ev) => {
          const dataUrl = ev.target?.result as string;
          // Downscale large screenshots: vision models tokenize every pixel
          const img = new Image();
          img.onload = () => {
            const MAX = 1536;
            const scale = Math.min(1, MAX / Math.max(img.width, img.height));
            let outUrl = dataUrl;
            if (scale < 1) {
              const canvas = document.createElement('canvas');
              canvas.width = Math.round(img.width * scale);
              canvas.height = Math.round(img.height * scale);
              canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
              outUrl = canvas.toDataURL('image/jpeg', 0.85);
            }
            const base64 = outUrl.split(',')[1] || '';
            setAttachments((prev) => [...prev, { name: file.name, content: '', image: base64, thumb: outUrl }]);
          };
          img.onerror = () => {
            const base64 = dataUrl.split(',')[1] || '';
            setAttachments((prev) => [...prev, { name: file.name, content: '', image: base64, thumb: dataUrl }]);
          };
          img.src = dataUrl;
        };
        reader.readAsDataURL(file);
        return;
      }

      // Documents (PDF/DOCX/XLSX/RTF) — parse on the backend
      if (isDoc) {
        if (file.size > 10_000_000) {
          setAttachments((prev) => [...prev, { name: t('cp.big10', { name: file.name }), content: '' }]);
          return;
        }
        setAttachments((prev) => [...prev, { name: file.name, content: '', pending: true }]);
        extractDocument(file)
          .then((res) => {
            setAttachments((prev) => {
              const at = prev.findIndex((a) => a.name === file.name && a.pending);
              const done: Attachment = { name: `${res.name} (${res.chars} chars)`, content: res.content };
              if (at < 0) return [...prev, done];
              const next = [...prev];
              next[at] = done;
              return next;
            });
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : 'parse error';
            setAttachments((prev) => [
              ...prev.filter((a) => !(a.name === file.name && a.pending)),
              { name: t('cp.failed', { name: file.name, msg }), content: '' },
            ]);
          });
        return;
      }

      if (isText) {
        if (file.size > 500_000) {
          setAttachments((prev) => [...prev, { name: t('cp.big', { name: file.name }), content: '' }]);
          return;
        }
        const reader = new FileReader();
        reader.onload = (ev) => {
          setAttachments((prev) => [...prev, { name: file.name, content: ev.target?.result as string }]);
        };
        reader.readAsText(file);
        return;
      }

      setAttachments((prev) => [...prev, { name: t('cp.unsupported', { name: file.name }), content: '' }]);
    });
  };

  /** Files or a screenshot from the clipboard (Ctrl+V), and long text as an attachment card. Returns true when it handled the paste. */
  const handlePaste = (data: DataTransfer | null): boolean => {
    if (!data) return false;
    const files = Array.from(data.files ?? []);
    if (files.length) {
      const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
      addFiles(files.map((f, i) => (/^image\.\w+$/i.test(f.name) ? new File([f], `screenshot-${stamp}${files.length > 1 ? `-${i + 1}` : ''}.${f.type.split('/')[1] || 'png'}`, { type: f.type }) : f)));
      return true;
    }
    const text = data.getData('text/plain');
    if (text && isBulkyText(text)) {
      setAttachments((prev) => [...prev, { name: nameForPastedText(text, prev.map((a) => a.name)), content: text }]);
      return true;
    }
    return false;
  };

  // Ctrl+V with the focus outside the message box (on the page) also attaches a copied picture or file
  useEffect(() => {
    const onDocPaste = (e: ClipboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest?.('input, textarea, [contenteditable="true"], .cm-editor')) return;
      if (e.clipboardData?.files?.length && handlePaste(e.clipboardData)) e.preventDefault();
    };
    document.addEventListener('paste', onDocPaste);
    return () => document.removeEventListener('paste', onDocPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drag files or screenshots from the desktop onto the chat form
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const onDragEnter = (e: React.DragEvent) => {
    if (!hasOsFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragDepth.current++;
    setDragging(true);
  };
  const onDragOver = (e: React.DragEvent) => { if (hasOsFiles(e.dataTransfer)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } };
  const onDragLeave = () => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDragging(false); };
  const onDrop = (e: React.DragEvent) => {
    if (!hasOsFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    addFiles(Array.from(e.dataTransfer.files));
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  if (collapsed) {
    return (
      <div className="border-t border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 py-1.5 flex items-center justify-between">
        <span className="text-xs text-[var(--text-muted)]">{t('cp.collapsedHint')}</span>
        <button onClick={() => setCollapsed(false)} className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-[var(--text-secondary)] hover:text-[var(--accent)] hover:bg-[var(--bg-hover)] transition-colors" title={t("cp.expandForm")}>
          <ChevronUp size={14} /> {t('cp.expand')}
        </button>
      </div>
    );
  }

  return (
    <div
      className={`relative border-t border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 py-3 ${dragging ? 'ring-2 ring-inset ring-[var(--accent)]' : ''}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-[var(--bg-secondary)]/85 text-sm font-medium text-[var(--accent)]">
          {t('cp.dropHere')}
        </div>
      )}
      {/* Attachments */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2 animate-fade-in">
          {attachments.map((a, i) => (
            <span
              key={`${a.name}-${i}`}
              className="inline-flex items-center gap-1.5 pr-1.5 pl-1.5 py-1 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-xs text-[var(--text-secondary)] max-w-[220px]"
            >
              {a.thumb ? (
                <img src={a.thumb} alt="" className="w-6 h-6 object-cover rounded" />
              ) : a.pending ? (
                <span className="w-3 h-3 rounded-full border-2 border-[var(--accent)] border-t-transparent animate-spin shrink-0" />
              ) : a.name.includes('failed') || a.name.includes('skipped') ? (
                <AlertTriangle size={13} className="text-[var(--warning)] shrink-0" />
              ) : (
                <FileText size={13} className="text-[var(--accent)] shrink-0" />
              )}
              <span className="truncate">{a.name}</span>
              <button
                onClick={() => removeAttachment(i)}
                className="ml-0.5 text-[var(--text-muted)] hover:text-[var(--error)] transition-colors shrink-0"
              >
                <X size={13} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Queue indicator */}
      {queuedCount > 0 && (
        <div className="flex items-center gap-1.5 mb-2 text-xs text-[var(--text-muted)] animate-fade-in">
          <div className="w-1.5 h-1.5 rounded-full bg-[var(--warning)] animate-pulse-slow" />
          {queuedCount} message{queuedCount > 1 ? 's' : ''} queued
        </div>
      )}

      {/* Options: capability toggles + model selector */}
      <div className="flex items-center gap-1.5 mb-2 flex-wrap [&>button]:h-[26px]">
        <ToggleChip
          icon={Wrench}
          label="Tools"
          active={toolsOn}
          onClick={() => setToolsOn((v) => !v)}
          title={toolsOn ? t('cp.toolsOn') : t('cp.toolsOff')}
        />
        <ToggleChip
          icon={Globe}
          label="Web"
          active={webOn}
          onClick={() => setWebOn((v) => !v)}
          title={webOn ? t('cp.web') : t('cp.webOff')}
        />
        <SkillsChip projectId={projectId} model={model} />

        <span className="ml-auto flex items-center gap-2">
          <SubscriptionLimitsBadge model={model} />
          <ContextMeter usage={usage ?? null} />
          <span className="text-[10px] text-[var(--text-muted)]/70 select-none hidden 2xl:inline">{t('cp.keys')}</span>

          {/* Model selector */}
          <div className="relative" ref={modelRef}>
            <button
              onClick={() => {
                const opening = !modelOpen;
                setModelOpen(opening);
                if (opening) void refreshModels();
              }}
              disabled={disabled}
              title={models.length === 0 ? t('cp.noModels') : t('cp.model')}
              className={`flex items-center gap-1.5 h-[26px] px-2 rounded-md border text-[11px] transition-colors disabled:opacity-50 ${
                modelOpen
                  ? 'border-[var(--accent)]/40 bg-[var(--accent-glow)] text-[var(--accent)]'
                  : 'border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:border-[var(--accent)]/40'
              }`}
            >
              <Cpu size={12} />
              <span className="max-w-[170px] truncate" title={model ?? undefined}>{model ? displayModel(model) : 'auto'}</span>
              {params.effort !== 'auto' && <span className="rounded bg-[var(--bg-hover)] px-1 text-[10px] text-[var(--text-muted)]">{params.effort}</span>}
              <ChevronDown size={11} className={`transition-transform ${modelOpen ? 'rotate-180' : ''}`} />
            </button>

            {modelOpen && (
              <ModelPicker
                models={models}
                value={model}
                params={params}
                loading={modelsLoading}
                onSelect={(m) => { setModel(m); pushRecent(m); setProjectModel(projectId, m); setModelOpen(false); }}
                onParams={(p) => { setParams(p); saveParams(p); }}
                onRefresh={() => void refreshModels()}
                onClose={() => setModelOpen(false)}
              />
            )}
          </div>

          {/* Collapse chat form — compact icon, right of the model selector */}
          <button
            onClick={() => setCollapsed(true)}
            title={t('cp.collapseTitle')}
            className="flex items-center justify-center w-7 h-7 rounded-md border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--accent)] hover:border-[var(--accent)]/40 transition-colors"
          >
            <ChevronDown size={14} />
          </button>
        </span>
      </div>

      <div className="flex items-end gap-2">
        {/* Attach button */}
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          title={t('cp.attach')}
          className="shrink-0 w-9 h-9 flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Paperclip size={17} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,.pdf,.docx,.xlsx,.rtf,.txt,.py,.js,.ts,.tsx,.jsx,.json,.md,.html,.css,.yaml,.yml,.toml,.env,.xml,.sql,.sh,.c,.cpp,.h,.java,.go,.rs,.rb,.php,.vue,.svelte,.csv,.log"
          onChange={handleFileSelect}
          className="hidden"
        />

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onPaste={(e) => { if (handlePaste(e.clipboardData)) e.preventDefault(); }}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter inserts a newline
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder={placeholder || t('cp.placeholder')}
          rows={1}
          className="flex-1 px-4 py-2.5 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] resize-none min-h-[42px] max-h-[200px] transition-colors"
        />

        {/* Stop / Send (split) */}
        {isProcessing ? (
          <button
            onClick={onStop}
            title={t('cp.stop')}
            className="shrink-0 h-[42px] px-4 rounded-lg bg-gray-500/15 border border-gray-500/40 text-gray-500 text-sm font-medium hover:bg-gray-500/25 transition-colors flex items-center gap-2"
          >
            <Square size={12} fill="currentColor" />
            Stop
          </button>
        ) : (
          <div className="shrink-0 flex relative" ref={sendMenuRef}>
            <button
              onClick={() => handleSend(false)}
              disabled={disabled || (!value.trim() && !attachments.some((a) => a.image || a.content)) || attachments.some((a) => a.pending)}
              className="h-[42px] pl-4 pr-3 rounded-l-lg bg-[var(--accent)] text-[var(--on-accent)] text-sm font-semibold hover:bg-[var(--accent-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
            >
              Send
              <ArrowUp size={15} />
            </button>
            <button
              onClick={() => setSendMenuOpen((v) => !v)}
              disabled={disabled || (!value.trim() && !attachments.some((a) => a.image || a.content))}
              title={t('cp.sendOptions')}
              className="h-[42px] px-2 rounded-r-lg bg-[var(--accent)] text-[var(--on-accent)] border-l border-[var(--on-accent)]/25 hover:bg-[var(--accent-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center"
            >
              <ChevronDown size={14} className={`transition-transform ${sendMenuOpen ? 'rotate-180' : ''}`} />
            </button>

            {sendMenuOpen && (
              <div className="absolute right-0 bottom-full mb-1.5 w-52 rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-xl overflow-hidden animate-fade-in z-30">
                <button
                  onClick={() => handleSend(false)}
                  className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-[var(--bg-hover)] transition-colors"
                >
                  <ArrowUp size={14} className="text-[var(--accent)] mt-0.5 shrink-0" />
                  <span className="min-w-0">
                    <span className="block text-sm text-[var(--text-primary)]">{t('cp.sendNow')}</span>
                    <span className="block text-[11px] text-[var(--text-muted)]">{t('cp.sendNowHint')}</span>
                  </span>
                </button>
                <div className="h-px bg-[var(--border-color)]" />
                <button
                  onClick={() => handleSend(true)}
                  disabled={!isProcessing}
                  className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <ListPlus size={14} className="text-[var(--accent)] mt-0.5 shrink-0" />
                  <span className="min-w-0">
                    <span className="block text-sm text-[var(--text-primary)]">{t('cp.queue')}</span>
                    <span className="block text-[11px] text-[var(--text-muted)]">
                      {isProcessing ? t('cp.queueBusy') : t('cp.queueIdle')}
                    </span>
                  </span>
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ToggleChip({
  icon: Icon,
  label,
  active,
  disabled,
  onClick,
  title,
}: {
  icon: typeof Wrench;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11px] transition-colors ${
        disabled
          ? 'border-dashed border-[var(--border-color)] text-[var(--text-muted)] opacity-60 cursor-not-allowed'
          : active
          ? 'border-[var(--accent)]/40 bg-[var(--accent-glow)] text-[var(--accent)]'
          : 'border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:border-[var(--text-muted)]'
      }`}
    >
      <Icon size={12} />
      {label}
    </button>
  );
}
