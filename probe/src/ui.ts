// Tiny DOM helpers for the probe UI.

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { cls?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  const { cls, ...rest } = props;
  if (cls) e.className = cls;
  Object.assign(e, rest);
  for (const c of children) e.append(c);
  return e;
}

export interface Card {
  root: HTMLElement;
  actions: HTMLElement;
  status(text: string): void;
  result(value: unknown): void;
}

export function card(id: string, title: string, desc: string): Card {
  const statusEl = el('div', { cls: 'status' });
  const resultEl = el('pre', { cls: 'result' });
  const actions = el('div', { cls: 'actions' });
  const root = el(
    'section',
    { cls: 'card', id },
    el('h2', {}, title),
    el('p', { cls: 'desc' }, desc),
    actions,
    statusEl,
    resultEl,
  );
  return {
    root,
    actions,
    status: (t) => (statusEl.textContent = t),
    result: (v) => (resultEl.textContent = v == null ? '' : JSON.stringify(v, null, 1)),
  };
}

export function button(label: string, onClick: (e: MouseEvent) => void, cls = ''): HTMLButtonElement {
  const b = el('button', { cls, type: 'button' }, label);
  b.addEventListener('click', onClick);
  return b;
}

/** Countdown that auto-runs `fn` unless cancelled; used to chain crash-and-restart runs. */
export function countdown(target: Card, seconds: number, label: string, fn: () => void): void {
  let left = seconds;
  let cancelled = false;
  const cancel = button('Cancel', () => {
    cancelled = true;
    cancel.remove();
    target.status(`${label}: cancelled. Tap the start button to resume.`);
  });
  target.actions.append(cancel);
  const tick = () => {
    if (cancelled) return;
    if (left <= 0) {
      cancel.remove();
      fn();
      return;
    }
    target.status(`${label} in ${left}s…`);
    left--;
    setTimeout(tick, 1000);
  };
  tick();
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}
