// A modal sheet (settings, projects, export...). Close and tap-outside return to the canvas.
import type { ComponentChildren } from 'preact';
import { ui } from './state';

export function Sheet(props: { title: string; wide?: boolean; children: ComponentChildren }) {
  return (
    <div class="sheet-back" onClick={(e) => e.target === e.currentTarget && (ui.sheet.value = 'none')}>
      <div class={props.wide ? 'sheet wide' : 'sheet'} role="dialog" aria-label={props.title}>
        <div class="sheet-head">
          <h2>{props.title}</h2>
          <button data-ui="chrome" onClick={() => (ui.sheet.value = 'none')}>Close</button>
        </div>
        {props.children}
      </div>
    </div>
  );
}
