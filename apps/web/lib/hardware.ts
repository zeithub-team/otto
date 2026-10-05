import { API_BASE } from './api';

export interface Hardware {
  ramGb: number;
  vramGb: number;
  gpus: Array<{ name: string; vramGb: number }>;
}

/** gpu = fits into video memory (fast); slow = runs from system RAM / CPU; no = does not fit at all. */
export type Fit = 'gpu' | 'slow' | 'no';

export interface FitInfo {
  fit: Fit;
  /** Memory the model needs at runtime, GB. */
  needGb: number;
}

export async function fetchHardware(): Promise<Hardware | null> {
  try {
    const res = await fetch(`${API_BASE}/api/hardware`);
    return res.ok ? ((await res.json()) as Hardware) : null;
  } catch {
    return null;
  }
}

/** Installed local models with their size on disk in GB. */
export async function fetchLocalSizes(): Promise<Record<string, number>> {
  try {
    const res = await fetch(`${API_BASE}/v1/models`);
    if (!res.ok) return {};
    const data = await res.json();
    const out: Record<string, number> = {};
    for (const m of Array.isArray(data?.models) ? data.models : []) {
      const name = m.name || m.model;
      if (name && typeof m.size === 'number' && m.size > 0) out[name] = m.size / 1024 ** 3;
    }
    return out;
  } catch {
    return {};
  }
}

/** "4.7 GB" / "900 MB" → GB (catalog sizes). */
export function parseSizeGb(text: string): number | null {
  const match = /([\d.,]+)\s*(GB|MB|ГБ|МБ)/i.exec(text);
  if (!match) return null;
  const value = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(value)) return null;
  return /^(MB|МБ)$/i.test(match[2]) ? value / 1024 : value;
}

/** Weights + KV cache and runtime overhead; a model that needs more than the RAM cannot start. */
export function fitOf(sizeGb: number, hw: Hardware): FitInfo {
  const needGb = Math.round((sizeGb * 1.15 + 1) * 10) / 10;
  if (hw.vramGb > 0 && needGb <= hw.vramGb) return { fit: 'gpu', needGb };
  if (needGb <= hw.ramGb * 0.85) return { fit: 'slow', needGb };
  return { fit: 'no', needGb };
}
