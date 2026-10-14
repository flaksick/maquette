// Projects sheet (P1b): the gallery (PRJ-1), project files in/out (PRJ-5) and back up all (PRJ-6).
// Every control carries the feature it belongs to (invariant 7).
import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Sheet } from './sheet';
import { ui } from './state';
import { bus } from './bus';
import { call, current, disk, lowSpace, openProject, projects, refreshProjects, refreshStorage, storage, trashProject } from './projects';
import { prefs, savePrefsNow, setPref } from './prefs';
import { TRASH_DAYS, type ExportedFile, type ImportResult, type ProjectInfo } from './shared/library';

const fmt = (n: number) => n.toLocaleString('en-US');
export const size = (b: number) => (b < 2 ** 20 ? `${Math.max(1, Math.round(b / 1024))} KB` : b < 2 ** 30 ? `${(b / 2 ** 20).toFixed(1)} MB` : `${(b / 2 ** 30).toFixed(2)} GB`);
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const daysSince = (iso: string) => Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 864e5));

/** Recently Deleted expanded (the disk banner opens the sheet with it expanded). */
export const showTrash = signal(false);
/** A prepared file waits for a fresh tap: sharing needs one, and preparing can take a while. */
const prepared = signal<(ExportedFile & { kind: 'project' | 'backup' }) | null>(null);
const busy = signal<string | null>(null);
const message = signal<{ level: 'info' | 'error'; text: string } | null>(null);

async function run<T>(label: string, f: () => Promise<T>): Promise<T | undefined> {
  busy.value = label;
  message.value = null;
  try {
    return await f();
  } catch (e) {
    message.value = { level: 'error', text: e instanceof Error ? e.message : String(e) };
    return undefined;
  } finally {
    busy.value = null;
    await refreshProjects().catch(() => {});
    await refreshStorage();
    if (disk.value.full) bus.send({ type: 'disk-retry' }); // space may have been freed
  }
}

function BackupBox(props: { live: number }) {
  const last = prefs.value.lastBackupAt;
  const days = last ? daysSince(last) : null;
  const stale = days === null || days >= 7;
  return (
    <div class={stale ? 'safety stale' : 'safety'}>
      <p class="backup-age" data-days={days ?? 'never'}>
        {days === null ? 'Never backed up.' : `Last backed up ${days === 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`}.`}
      </p>
      <p class="dim">
        Your projects are stored only on this iPad. Deleting the Maquette icon from the Home Screen deletes all of them. A backup is one
        .zip file you can keep in Files.
      </p>
      <div class="row">
        <button
          class="primary"
          data-feature="PRJ-6"
          disabled={!!busy.value || props.live === 0}
          onClick={() =>
            run('Preparing the backup…', async () => {
              prepared.value = { ...(await call<ExportedFile>({ op: 'backup' })), kind: 'backup' };
            })
          }
        >
          Back up all…
        </button>
      </div>
    </div>
  );
}

function PreparedFile() {
  const f = prepared.value;
  if (!f) return null;
  const feature = f.kind === 'backup' ? 'PRJ-6' : 'PRJ-5';
  const finished = (how: string) => {
    if (f.kind === 'backup') {
      setPref({ lastBackupAt: new Date().toISOString() });
      void savePrefsNow().catch(() => {});
    }
    message.value = { level: 'info', text: `${f.name}: ${how}.` };
    prepared.value = null;
  };
  const share = async () => {
    try {
      if (navigator.canShare?.({ files: [f.file] })) {
        await navigator.share({ files: [f.file], title: f.name });
        finished('shared');
        return;
      }
      message.value = { level: 'info', text: 'This browser can’t share files; use Download.' };
    } catch (e) {
      if ((e as Error).name !== 'AbortError') message.value = { level: 'error', text: `Share failed: ${e}` };
    }
  };
  const download = () => {
    const url = URL.createObjectURL(f.file);
    const a = document.createElement('a');
    a.href = url;
    a.download = f.name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    finished('downloaded');
  };
  return (
    <div class="prepared" data-prepared={f.kind}>
      <p>
        <strong>{f.name}</strong> · {size(f.bytes)}
        {f.kind === 'backup' ? ` · ${f.projects} project${f.projects === 1 ? '' : 's'}` : ''}
      </p>
      <div class="row">
        <button class="primary" data-feature={feature} onClick={() => void share()}>
          Share…
        </button>
        <button data-feature={feature} onClick={download}>
          Download
        </button>
        <button data-ui="chrome" onClick={() => (prepared.value = null)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function ProjectRow(props: { p: ProjectInfo; all: ProjectInfo[] }) {
  const { p } = props;
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(p.name);
  const isOpen = p.id === current.value?.id;
  const saveName = () =>
    run('Renaming…', async () => {
      await call({ op: 'rename', projectId: p.id, name });
      if (isOpen) current.value = { id: p.id, name: name.trim() };
      setRenaming(false);
    });
  return (
    <li class={isOpen ? 'project open' : 'project'} data-project={p.id}>
      <div class="project-info">
        {renaming ? (
          <input
            class="rename"
            data-feature="PRJ-1"
            value={name}
            maxLength={80}
            aria-label="Project name"
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.key === 'Enter' && void saveName()}
          />
        ) : (
          <strong class="project-name">{p.name}</strong>
        )}
        {isOpen && <span class="chip ok">Open</span>}
        <div class="dim">
          {fmt(p.tris)} tris · {size(p.bytes)} · {when(p.modifiedAt)}
        </div>
      </div>
      <div class="project-actions">
        {renaming ? (
          <>
            <button class="primary" data-feature="PRJ-1" disabled={!name.trim() || !!busy.value} onClick={() => void saveName()}>
              Save
            </button>
            <button data-ui="chrome" onClick={() => (setRenaming(false), setName(p.name))}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              class="primary"
              data-feature="PRJ-1"
              disabled={isOpen || !!busy.value}
              onClick={() =>
                run('Opening…', async () => {
                  await openProject(p.id);
                  ui.sheet.value = 'none';
                })
              }
            >
              Open
            </button>
            <button data-feature="PRJ-1" disabled={!!busy.value} onClick={() => (setName(p.name), setRenaming(true))}>
              Rename
            </button>
            <button data-feature="PRJ-1" disabled={!!busy.value || lowSpace.value} onClick={() => run('Duplicating…', () => call({ op: 'duplicate', projectId: p.id }))}>
              Duplicate
            </button>
            <button
              data-feature="PRJ-5"
              disabled={!!busy.value}
              onClick={() =>
                run('Preparing the project file…', async () => {
                  prepared.value = { ...(await call<ExportedFile>({ op: 'export', projectId: p.id })), kind: 'project' };
                })
              }
            >
              Export
            </button>
            <button data-feature="PRJ-1" disabled={!!busy.value} onClick={() => run('Deleting…', () => trashProject(p, props.all))}>
              Delete
            </button>
          </>
        )}
      </div>
    </li>
  );
}

function TrashRow(props: { p: ProjectInfo }) {
  const { p } = props;
  const [confirm, setConfirm] = useState(false);
  const left = Math.max(0, TRASH_DAYS - daysSince(p.deletedAt!));
  return (
    <li class="project trashed" data-project={p.id}>
      <div class="project-info">
        <strong class="project-name">{p.name}</strong>
        <div class="dim">
          {fmt(p.tris)} tris · {size(p.bytes)} · deleted {when(Date.parse(p.deletedAt!))} · removed for good in {left} day{left === 1 ? '' : 's'}
        </div>
      </div>
      <div class="project-actions">
        <button data-feature="PRJ-1" disabled={!!busy.value} onClick={() => run('Restoring…', () => call({ op: 'restore', projectId: p.id }))}>
          Restore
        </button>
        <button
          class={confirm ? 'danger' : ''}
          data-feature="PRJ-1"
          disabled={!!busy.value}
          onClick={() => (confirm ? void run('Deleting for good…', () => call({ op: 'purge', projectId: p.id })) : setConfirm(true))}
        >
          {confirm ? 'Delete forever' : 'Delete now…'}
        </button>
      </div>
    </li>
  );
}

export function ProjectsSheet() {
  const list = projects.value;
  const picker = useRef<HTMLInputElement>(null);
  useEffect(() => {
    message.value = null;
    void refreshProjects().catch((e) => (message.value = { level: 'error', text: `Storage is unavailable here (${e.message}).` }));
    void refreshStorage();
    return () => (prepared.value = null);
  }, []);
  const live = (list ?? []).filter((p) => !p.deletedAt);
  const trash = (list ?? []).filter((p) => p.deletedAt);
  const s = storage.value;
  const onFile = (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    // No `accept` filter on the picker (iPadOS greys out unknown types, DECISIONS S7): check here.
    if (!/\.(maquette|zip)$/i.test(file.name)) {
      message.value = { level: 'error', text: `${file.name} isn’t a Maquette project (.maquette) or backup (.zip).` };
      return;
    }
    void run('Importing…', async () => {
      const r = await call<ImportResult & { failed: { folder: string; error: string }[] }>({ op: 'import', file });
      const n = r.projects.length;
      message.value = {
        level: r.failed.length ? 'error' : 'info',
        text: `Imported ${n} project${n === 1 ? '' : 's'}${r.failed.length ? `; ${r.failed.length} could not be read (${r.failed[0].error})` : ''}.`,
      };
    });
  };
  return (
    <Sheet title="Projects" wide>
      <BackupBox live={live.length} />
      {lowSpace.value && s && (
        <p class="warn-text">
          Storage is almost full ({size(Math.max(0, s.quota - s.usage))} left): new projects, duplicates and imports are paused. Back up, then
          empty Recently Deleted.
        </p>
      )}
      <PreparedFile />
      <div class="row">
        <button data-feature="PRJ-1" disabled={!!busy.value || lowSpace.value} onClick={() => (ui.sheet.value = 'new')}>
          New sphere…
        </button>
        <button data-feature="PRJ-5" disabled={!!busy.value || lowSpace.value} onClick={() => picker.current?.click()}>
          Import…
        </button>
        <input ref={picker} type="file" hidden data-feature="PRJ-5" onChange={onFile} />
        <span class="dim">
          {live.length} project{live.length === 1 ? '' : 's'}
          {s ? ` · ${size(s.usage)} used · ${size(Math.max(0, s.quota - s.usage))} free` : ''}
        </span>
      </div>
      {busy.value && <p class="dim">{busy.value}</p>}
      {message.value && <p class={message.value.level === 'error' ? 'warn-text' : 'ok-text'}>{message.value.text}</p>}
      {list === null ? (
        <p class="dim">Loading…</p>
      ) : (
        <ul class="projects">
          {live.map((p) => (
            <ProjectRow key={p.id} p={p} all={list} />
          ))}
        </ul>
      )}
      <div class="row">
        <button data-feature="PRJ-1" aria-expanded={showTrash.value} onClick={() => (showTrash.value = !showTrash.value)}>
          Recently Deleted ({trash.length})
        </button>
        <span class="dim">Deleted projects stay here for {TRASH_DAYS} days.</span>
      </div>
      {showTrash.value && (
        <ul class="projects">
          {trash.map((p) => (
            <TrashRow key={p.id} p={p} />
          ))}
        </ul>
      )}
    </Sheet>
  );
}
