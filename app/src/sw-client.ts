// Service-worker client: offline install (PLT-1), update policy (PLT-2/PLT-3 basic).
// The only network the app ever uses is fetching its own files; auto-checks can be turned off.
import { signal } from '@preact/signals';
import { prefs, prefsReady, setPref } from './prefs';

export const offline = signal<{ ready: boolean; version: string | null; files: number }>({ ready: false, version: null, files: 0 });
export const updateWaiting = signal(false);

// The setting lives in the preferences file (PRJ-11; it was a localStorage key in P1a).
export function autoUpdate(): boolean {
  return prefs.value.autoUpdate;
}
export function setAutoUpdate(on: boolean): void {
  setPref({ autoUpdate: on });
}

interface SwStatus {
  version?: string | null;
  verified?: boolean;
  files?: number;
  layout?: string | null;
  pending?: string | null;
  reverted?: { from: string; to: string; t: string } | null;
}
/** The version Maquette went back to after a release failed to start twice (PLT-3). */
export const reverted = signal<{ from: string; to: string; t: string } | null>(null);

/** One request to the service worker in charge (or the active one before it controls this page). */
async function ask<T>(msg: Record<string, unknown>, timeoutMs = 3000): Promise<T | null> {
  const w = navigator.serviceWorker?.controller ?? (await navigator.serviceWorker?.getRegistration())?.active;
  if (!w) return null;
  const ch = new MessageChannel();
  return new Promise<T | null>((resolve) => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    ch.port1.onmessage = (e) => {
      clearTimeout(t);
      resolve(e.data as T);
    };
    w.postMessage(msg, [ch.port2]);
  });
}

async function status(): Promise<void> {
  if (!navigator.serviceWorker?.controller) return;
  const info = await ask<SwStatus>({ type: 'status' });
  if (!info) return;
  offline.value = { ready: !!info.verified, version: info.version ?? null, files: info.files ?? 0 };
  if (info.pending) updateWaiting.value = true;
  reverted.value = info.reverted ?? null;
}

/** PLT-3 boot health: this version opened a project, so the worker marks it good (until then, two
 *  failed launches send Maquette back to the previous good version). */
let bootOk = false;
export async function reportBootOk(): Promise<void> {
  if (bootOk || !('serviceWorker' in navigator)) return;
  const r = await ask<{ good?: boolean }>({ type: 'boot-ok', entry: import.meta.url });
  if (r?.good) bootOk = true;
}

/** Asks the worker to look for a new version (versions.json) and download + verify it. */
async function checkVersions(): Promise<{ status?: string; error?: string } | null> {
  return ask({ type: 'check-update' }, 120_000);
}

export async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      void status();
      void reportBootOk(); // a first visit is controlled only once the worker activates
    });
    const watch = (w: ServiceWorker | null) =>
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) updateWaiting.value = true;
        if (w.state === 'activated') void status();
      });
    if (reg.waiting && navigator.serviceWorker.controller) updateWaiting.value = true;
    watch(reg.installing);
    reg.addEventListener('updatefound', () => watch(reg.installing));
    await status();
    if (!offline.value.ready) setTimeout(() => void status(), 4000);
    await prefsReady; // the user's choice, not the default, decides the automatic check
    if (autoUpdate() && navigator.onLine) {
      void reg.update().catch(() => {}); // the worker's own code
      void checkVersions().then(() => status()); // the app's versions (downloaded silently, applied next launch)
    }
  } catch {
    // No service worker (http on the LAN, private mode): the app still runs, just not offline.
  }
}

export async function checkForUpdate(): Promise<string> {
  const reg = await navigator.serviceWorker?.getRegistration();
  if (!reg) return 'No service worker on this page.';
  try {
    await reg.update();
  } catch {
    return 'Couldn’t reach the update server (offline?).';
  }
  const r = await checkVersions();
  await status();
  if (r?.error) return `Update check failed: ${r.error}`;
  if (r?.status === 'pending' || reg.installing || reg.waiting) return 'An update is downloaded and verified. It applies the next time you open Maquette.';
  if (r?.status === 'bad') return 'The newest version failed to start on this iPad; Maquette stays on the version that works.';
  return 'You have the latest version.';
}
