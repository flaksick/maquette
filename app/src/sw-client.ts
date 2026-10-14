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

async function status(): Promise<void> {
  const ctl = navigator.serviceWorker?.controller;
  if (!ctl) return;
  const ch = new MessageChannel();
  const info = await new Promise<{ version?: string; verified?: boolean; files?: number } | null>((resolve) => {
    const t = setTimeout(() => resolve(null), 3000);
    ch.port1.onmessage = (e) => {
      clearTimeout(t);
      resolve(e.data);
    };
    ctl.postMessage({ type: 'status' }, [ch.port2]);
  });
  if (info) offline.value = { ready: !!info.verified, version: info.version ?? null, files: info.files ?? 0 };
}

export async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' });
    navigator.serviceWorker.addEventListener('controllerchange', () => void status());
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
    if (autoUpdate() && navigator.onLine) void reg.update().catch(() => {});
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
  return reg.installing || reg.waiting ? 'Update downloading. It applies the next time you open Maquette.' : 'You have the latest version.';
}
