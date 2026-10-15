// Builds and publishes to GitHub Pages. GitHub only stores and serves the files; everything is
// built and verified here (invariant 0). The `gh-pages` branch is a git worktree in ./deploy.
//   node scripts/deploy.mjs dev    app dev channel -> /maquette/dev/  (+ probe at /dev/probe/)
//   node scripts/deploy.mjs prod   app prod channel -> /maquette/     (keeps /dev/)
// Add --no-push to assemble without publishing.
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleProd } from './release.mjs';

const channel = process.argv[2];
const push = !process.argv.includes('--no-push');
if (channel !== 'dev' && channel !== 'prod') {
  console.error('usage: node scripts/deploy.mjs dev|prod [--no-push]');
  process.exit(1);
}
const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', ...opts });
const out = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();

run('npm run app:build');
run('npx vite build --config vite.probe.config.ts');
run('node scripts/gen-spec.mjs --check');
run('node scripts/gen-notices.mjs');

// gh-pages worktree
if (!existsSync('deploy/.git')) {
  rmSync('deploy', { recursive: true, force: true });
  const hasRemoteBranch = out('git ls-remote --heads origin gh-pages') !== '';
  if (hasRemoteBranch) {
    run('git fetch origin gh-pages');
    run('git worktree add -B gh-pages deploy origin/gh-pages');
  } else {
    run('git worktree add --detach deploy');
    run('git checkout --orphan gh-pages', { cwd: 'deploy' });
    run('git rm -rf --quiet . || true', { cwd: 'deploy' });
  }
} else if (push) {
  run('git pull --ff-only origin gh-pages', { cwd: 'deploy' });
}

/** Replace `dir` with `src`, keeping the listed children of `dir`. */
function replaceDir(dir, src, keep) {
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) {
    if (!keep.includes(name)) rmSync(join(dir, name), { recursive: true, force: true });
  }
  cpSync(src, dir, { recursive: true });
}

if (channel === 'dev') {
  replaceDir('deploy/dev', 'dist/app-dev', ['probe']);
  rmSync('deploy/dev/probe', { recursive: true, force: true });
  cpSync('dist/probe', 'deploy/dev/probe', { recursive: true });
} else {
  // PLT-3: a new immutable folder v/<id>/ (the newest 3 kept), the stable sw.js, boot index and
  // versions.json at the root; /dev/ and /dev/probe/ are untouched.
  const rel = assembleProd({ dist: 'dist/app-prod', root: 'deploy' });
  console.log(`prod release: ${rel.describe}`);
}
writeFileSync('deploy/.nojekyll', '');
cpSync('THIRD_PARTY_NOTICES.md', 'deploy/THIRD_PARTY_NOTICES.md');

// Last fence before anything leaves the machine (invariant 11), then publish.
run('gitleaks dir deploy --redact --no-banner -l warn');
const version = channel === 'dev' ? JSON.parse(readFileSync('deploy/dev/precache.json', 'utf8')).version : JSON.parse(readFileSync('deploy/versions.json', 'utf8')).current;
run('git add -A', { cwd: 'deploy' });
const dirty = out('git -C deploy status --porcelain') !== '';
if (dirty) run(`git commit -q -m "${channel}: app ${version}"`, { cwd: 'deploy' });
if (push) run('git push -u origin gh-pages', { cwd: 'deploy' });
const url = channel === 'dev' ? 'https://flaksick.github.io/maquette/dev/' : 'https://flaksick.github.io/maquette/';
console.log(`${channel} ${dirty ? 'updated' : 'unchanged'}: app ${version}${push ? ' (pushed)' : ' (not pushed)'}\nURL: ${url}`);
