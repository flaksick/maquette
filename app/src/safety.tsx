// Daily-safety UI (P1b): the disk banner (PLT-11), storage numbers in Settings (PLT-4) and the
// gesture card (NAV-10).
import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { ui } from './state';
import { bus } from './bus';
import { disk, lowSpace, refreshStorage, storage } from './projects';
import { prefs, prefsSource, savePrefsNow, setPref } from './prefs';
import { showTrash, size } from './gallery';

/** PLT-11: sculpting waits while a change isn't saved; growth waits while space is low. Both
 *  offer what frees space: a backup (then deleting projects) and Recently Deleted. */
export function DiskBanner() {
  const d = disk.value;
  const s = storage.value;
  if (!d.full && !lowSpace.value) return null;
  const free = s ? size(Math.max(0, s.quota - s.usage)) : '?';
  return (
    <div class="banner" data-banner="disk">
      <span>
        {d.full
          ? `Storage is full${d.unsaved ? `: ${d.unsaved} change${d.unsaved === 1 ? '' : 's'} not saved yet` : ''}. Sculpting is paused so nothing is lost. Free space, then tap Try again.`
          : `Storage is almost full (${free} left). New projects, duplicates and imports are paused.`}
      </span>
      <span class="banner-actions">
        {d.full && (
          <button data-feature="PLT-11" onClick={() => bus.send({ type: 'disk-retry' })}>
            Try again
          </button>
        )}
        <button data-feature="PLT-11" onClick={() => ((showTrash.value = false), (ui.sheet.value = 'projects'))}>
          Back up…
        </button>
        <button data-feature="PLT-11" onClick={() => ((showTrash.value = true), (ui.sheet.value = 'projects'))}>
          Recently Deleted…
        </button>
      </span>
    </div>
  );
}

/** PLT-4: what Maquette uses, what's left, and whether Safari granted persistent storage. */
export function StorageSettings() {
  useEffect(() => void refreshStorage(), []);
  const s = storage.value;
  return (
    <>
      <p class="dim" data-storage={s ? `${s.usage}/${s.quota}/${s.persisted}` : 'unavailable'}>
        {s
          ? `Storage: ${size(s.usage)} used · ${size(Math.max(0, s.quota - s.usage))} available${s.simulated ? ' (simulated disk)' : ''} · persistent storage ${s.persisted ? 'granted' : 'not granted (Safari may clear website data when the iPad is low on space)'}.`
          : 'Storage: unavailable in this window.'}
      </p>
      <div class="row">
        <button
          data-feature="NAV-10"
          onClick={() => {
            ui.sheet.value = 'none';
            gestureCardOpen.value = true;
          }}
        >
          Gestures…
        </button>
      </div>
    </>
  );
}

/** NAV-10: re-opened from Settings; on first run it shows until dismissed. */
export const gestureCardOpen = signal(false);

export function GestureCard() {
  const firstRun = prefsSource.value !== 'loading' && !prefs.value.gestureCardSeen;
  if (!gestureCardOpen.value && !firstRun) return null;
  const finger = ui.fingerSculpts.value;
  const dismiss = () => {
    gestureCardOpen.value = false;
    if (!prefs.value.gestureCardSeen) {
      setPref({ gestureCardSeen: true });
      void savePrefsNow().catch(() => {});
    }
  };
  return (
    <div class="gesture-card" role="dialog" aria-label="Gestures">
      <h3>Gestures</h3>
      <ul>
        <li>
          <b>Apple Pencil</b> sculpts{finger ? '; so does one finger (Finger sculpts is on)' : ''}.
        </li>
        {!finger && (
          <li>
            <b>One finger</b> turns the view around the point you touch.
          </li>
        )}
        <li>
          <b>Two fingers</b> move the view; pinch to zoom.
        </li>
        <li>
          <b>Two-finger tap</b> undoes. Redo is the button at the top.
        </li>
      </ul>
      <button class="primary" data-feature="NAV-10" onClick={dismiss}>
        Got it
      </button>
    </div>
  );
}
