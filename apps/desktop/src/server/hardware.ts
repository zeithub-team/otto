import * as os from 'os';
import { execFile } from 'child_process';

/** What the machine can run local models with. */
export interface Hardware {
  /** Total system memory, GB. */
  ramGb: number;
  /** Video memory of the biggest NVIDIA GPU, GB (0 = none found / not NVIDIA). */
  vramGb: number;
  gpus: Array<{ name: string; vramGb: number }>;
}

const GB = 1024 ** 3;
let cache: { at: number; value: Hardware } | null = null;

/** NVIDIA cards via nvidia-smi (AMD / Intel report no dedicated memory here: treated as CPU-only). */
function nvidiaGpus(): Promise<Hardware['gpus']> {
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 4000, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve([]);
        const gpus = String(stdout)
          .split(/\r?\n/)
          .map((line) => line.split(',').map((part) => part.trim()))
          .filter((parts) => parts.length >= 2 && Number(parts[1]) > 0)
          .map((parts) => ({ name: parts[0], vramGb: Math.round((Number(parts[1]) / 1024) * 10) / 10 }));
        resolve(gpus);
      },
    );
  });
}

export async function getHardware(): Promise<Hardware> {
  if (cache && Date.now() - cache.at < 60_000) return cache.value;
  const gpus = await nvidiaGpus();
  const value: Hardware = {
    ramGb: Math.round((os.totalmem() / GB) * 10) / 10,
    vramGb: gpus.reduce((max, gpu) => Math.max(max, gpu.vramGb), 0),
    gpus,
  };
  cache = { at: Date.now(), value };
  return value;
}
