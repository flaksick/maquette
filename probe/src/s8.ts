// Spike S8: install, offline launch, storage isolation, updates (PLT-1/2/3, PRJ-6).
import { button, el, type Card } from './ui';
import { results, store } from './store';

export async function swStatus(): Promise<Record<string, unknown> | null> {
  const ctl = navigator.serviceWorker?.controller;
  if (!ctl) return null;
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 3000);
    ch.port1.onmessage = (e) => {
      clearTimeout(timer);
      resolve(e.data as Record<string, unknown>);
    };
    ctl.postMessage({ type: 'status' }, [ch.port2]);
  });
}

export async function recordLaunch(): Promise<Record<string, unknown>> {
  const standalone = matchMedia('(display-mode: standalone)').matches;
  const sw = await swStatus();
  const launch = {
    t: new Date().toISOString(),
    standalone,
    online: navigator.onLine,
    controlled: !!navigator.serviceWorker?.controller,
    crossOriginIsolated,
    swVersion: sw?.version ?? null,
    readyOffline: sw?.verified === true,
  };
  await results.append('s8', 'launches', launch);

  // Isolation: each context writes its own marker and reports which markers it can see.
  const ctx = standalone ? 'standalone' : 'browser';
  await store.set(`ctx-${ctx}.json`, { t: launch.t, ua: navigator.userAgent });
  const other = await store.get(`ctx-${standalone ? 'browser' : 'standalone'}.json`);
  await results.merge('s8', { [`${ctx}SeesOtherContext`]: other !== null });
  return launch;
}

export function mountInstall(c: Card, launch: Record<string, unknown>): void {
  c.status(
    `standalone: ${launch.standalone} · online: ${launch.online} · SW controlled: ${launch.controlled} · ` +
      `ready offline: ${launch.readyOffline} · version: ${launch.swVersion ?? '–'}`,
  );
  c.actions.append(
    button('Check for update', async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) return c.status('no service worker registration');
      const t0 = performance.now();
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw?.addEventListener('statechange', async () => {
          if (nw.state === 'installed' || nw.state === 'activated') {
            await results.merge('s8', { updateInstalledMs: Math.round(performance.now() - t0) });
            c.status(`update ${nw.state} after ${Math.round(performance.now() - t0)} ms — relaunch to use it`);
          }
        });
      });
      await reg.update();
      c.status('checked; if a new version exists it is downloading now');
    }),
  );
  const dummyAnswer = (survived: boolean) => async () => {
    await results.merge('s8', { dummyMarkerSurvivedIconDelete: survived });
    c.status(`recorded: marker ${survived ? 'survived' : 'did not survive'} deleting the icon`);
  };
  c.root.append(
    el('h3', {}, 'Icon-delete test (uses a separate dummy app, not this one)'),
    el(
      'ol',
      {},
      el('li', {}, 'Open the dummy page, Add it to the Home Screen, open it from there once.'),
      el('li', {}, 'Delete the dummy icon, add it again, open it again.'),
      el('li', {}, 'The dummy says whether its old marker survived. Record it here:'),
    ),
    el('div', { cls: 'actions' },
      el('a', { href: './dummy.html', cls: 'buttonlike', target: '_blank' }, 'Open dummy page'),
      button('Marker survived', dummyAnswer(true)),
      button('Marker gone', dummyAnswer(false)),
    ),
    el('p', { cls: 'desc' }, 'Offline launch test: turn on Airplane Mode, swipe this app closed, open it from the Home Screen. The launch is recorded automatically.'),
  );
}
