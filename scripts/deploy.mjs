// Builds and publishes a channel to GitHub Pages. GitHub only stores and serves the files;
// everything is built and verified here (invariant 0). The `gh-pages` branch is checked out as a
// git worktree in ./deploy (ignored by the main tree).
// Usage: node scripts/deploy.mjs dev [--no-push]
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const channel = process.argv[2];
const push = !process.argv.includes('--no-push');
if (channel !== 'dev') {
  console.error('only the dev channel exists in P0 (prod ships with P1a)');
  process.exit(1);
}
const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', ...opts });
const out = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();

run('npm run probe:build');
run('node scripts/gen-spec.mjs --check');
run('node scripts/gen-notices.mjs');

// gh-pages worktree
if (!existsSync('deploy/.git')) {
  rmSync('deploy', { recursive: true, force: true });
  const remote = out('git remote').split('\n').includes('origin');
  const hasRemoteBranch = remote && out('git ls-remote --heads origin gh-pages') !== '';
  if (hasRemoteBranch) {
    run('git fetch origin gh-pages');
    run('git worktree add -B gh-pages deploy origin/gh-pages');
  } else {
    run('git worktree add --detach deploy');
    run('git checkout --orphan gh-pages', { cwd: 'deploy' });
    run('git rm -rf --quiet . || true', { cwd: 'deploy' });
  }
} else if (push && out('git ls-remote --heads origin gh-pages') !== '') {
  run('git pull --ff-only origin gh-pages', { cwd: 'deploy' });
}

// Assemble: only the dev channel's folder is replaced; anything else on the branch is kept.
rmSync('deploy/dev/probe', { recursive: true, force: true });
mkdirSync('deploy/dev', { recursive: true });
cpSync('dist/probe', 'deploy/dev/probe', { recursive: true });
writeFileSync('deploy/.nojekyll', '');
cpSync('THIRD_PARTY_NOTICES.md', 'deploy/THIRD_PARTY_NOTICES.md');
if (!existsSync('deploy/index.html')) {
  writeFileSync(
    'deploy/index.html',
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Maquette</title><body style="font:18px -apple-system,system-ui,sans-serif;background:#141418;color:#ebe6df;padding:24px">
<h1>Maquette</h1><p>Offline sculpting for iPad. Not released yet.</p></body>`,
  );
}

// Last fence before anything leaves the machine (invariant 11), then publish.
run('gitleaks dir deploy --redact --no-banner -l warn');
const version = JSON.parse(readFileSync('deploy/dev/probe/precache.json', 'utf8')).version;
run('git add -A', { cwd: 'deploy' });
const dirty = out('git -C deploy status --porcelain') !== '';
if (dirty) run(`git commit -q -m "dev: probe ${version}"`, { cwd: 'deploy' });
if (push) run('git push -u origin gh-pages', { cwd: 'deploy' });
console.log(`dev channel ${dirty ? 'updated' : 'unchanged'}: probe ${version}${push ? ' (pushed)' : ' (not pushed)'}`);
console.log('URL: https://flaksick.github.io/maquette/dev/probe/');
