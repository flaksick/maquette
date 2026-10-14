// Prod release assembly, shared by deploy.mjs and the e2e trees (so tests serve exactly what ships).
import { cpSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Copies a prod build to the root of `root` (flat layout). Returns { version }. */
export function assembleProd({ dist = 'dist/app-prod', root }) {
  cpSync(dist, root, { recursive: true });
  const version = JSON.parse(readFileSync(join(dist, 'precache.json'), 'utf8')).version;
  return { version, describe: `flat, app ${version}` };
}
