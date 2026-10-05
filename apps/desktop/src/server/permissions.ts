/** One-shot confirmations for terminal sessions and mutating SSH operations. */
import { randomUUID } from 'node:crypto';

type Pending = { resolve: (allow: boolean) => void; timer: NodeJS.Timeout };
const pending = new Map<string, Pending>();
const requests = new Map<string, { id: string; kind: string; action: string; target?: string }>();
const TIMEOUT_MS = 5 * 60 * 1000;

export function requestPermission(details: { kind: 'terminal' | 'ssh'; action: string; target?: string }): { id: string; decision: Promise<boolean> } {
  const id = randomUUID();
  const event = { id, ...details };
  requests.set(id, event);
  const decision = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve(false); }, TIMEOUT_MS);
    pending.set(id, { resolve, timer });
  });
  setImmediate(() => permissionEvents?.(event));
  return { id, decision };
}

let permissionEvents: ((item: { id: string; kind: string; action: string; target?: string }) => void) | null = null;
export function setPermissionEventHandler(handler: typeof permissionEvents): void { permissionEvents = handler; }
export function subscribePermissionEvents(handler: NonNullable<typeof permissionEvents>): () => void {
  permissionEvents = handler;
  return () => { if (permissionEvents === handler) permissionEvents = null; };
}

export function resolvePermission(id: string, allow: boolean): boolean {
  const item = pending.get(id);
  if (!item) return false;
  clearTimeout(item.timer);
  pending.delete(id);
  requests.delete(id);
  item.resolve(allow);
  return true;
}

export const pendingPermissionRequests = (): Array<{ id: string; kind: string; action: string; target?: string }> => [...requests.values()];

export function resolveAllPermissions(allow = false): void {
  for (const id of [...pending.keys()]) resolvePermission(id, allow);
}
