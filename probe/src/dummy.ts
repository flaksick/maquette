// Dummy app for the icon-delete test (S8): reports whether a marker from a previous install
// survived, then writes a fresh one.
import { store } from './store';

const out = document.getElementById('out')!;
const prev = await store.get<{ id: string; t: string }>('dummy-marker.json');
const id = Math.random().toString(36).slice(2, 8);
await store.set('dummy-marker.json', { id, t: new Date().toISOString() });
const standalone = matchMedia('(display-mode: standalone)').matches;
out.textContent = prev
  ? `Old marker FOUND (id ${prev.id}, written ${prev.t}). New marker ${id} written.`
  : `No old marker. New marker ${id} written.`;
out.append(document.createElement('br'), `Running as: ${standalone ? 'Home Screen app' : 'Safari tab'}`);
