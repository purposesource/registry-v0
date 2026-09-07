// Test helpers: running a gate as a real child process, and building throwaway copies of
// the fixture trees.
//
// The gates are run as PROCESSES rather than imported, on purpose. Every one of them ends
// in process.exit(), and their contract with CI is "non-zero exit plus a message that
// names the file". Importing them would test the internals while leaving the contract
// untested — and the contract is the thing CI depends on.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = join(fileURLToPath(import.meta.url), '..', '..');

/** A fixed instant so nothing in the suite depends on the day it runs. */
export const NOW = '2027-01-15T00:00:00Z';

/**
 * Runs `node scripts/<script>` with the given args.
 * Returns { code, stdout, stderr } — never throws on a non-zero exit, because a non-zero
 * exit is what half these tests are asserting.
 */
export function runScript(script, args = [], env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [join(REPO, 'scripts', script), ...args], {
      cwd: REPO,
      encoding: 'utf8',
      // A deterministic child environment. CI and GITHUB_ACTIONS are cleared so a run
      // under Actions behaves like a run on a laptop; PSN_BASE_REF is cleared because a
      // workflow value written to $GITHUB_ENV leaks into every later step of the job —
      // including these tests, four of which assert the guards' OWN no-baseline branch
      // and cannot assert it while a baseline is inherited. Whatever the caller passes in
      // `env` still wins, so a test can hand a gate a baseline on purpose.
      env: { ...process.env, GENERATED_AT: NOW, CI: '', GITHUB_ACTIONS: '', PSN_BASE_REF: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      code: err.status === undefined ? 1 : err.status,
      stdout: err.stdout ? String(err.stdout) : '',
      stderr: err.stderr ? String(err.stderr) : '',
    };
  }
}

/** A fresh temp directory, removed by the OS rather than by us (tests must not rm -rf). */
export function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), `psn-registry-${prefix}-`));
}

/**
 * Copies one or more source trees into a temp workspace UNDER the repo, because the gates
 * resolve --dir relative to the repository root. Returns the repo-relative path.
 */
export function workspace(prefix, trees) {
  const abs = mkdtempSync(join(REPO, `.tmp-${prefix}-`));
  for (const [name, from] of Object.entries(trees)) {
    cpSync(join(REPO, from), join(abs, name), { recursive: true });
  }
  return relative(REPO, abs).split(sep).join('/');
}

/** Removes a workspace created by workspace(). Tests call this from an `after` hook. */
export function cleanup(relPath) {
  if (!relPath || !relPath.startsWith('.tmp-')) {
    throw new Error(`cleanup refuses to remove ${relPath}: only .tmp-* workspaces.`);
  }
  rmSync(join(REPO, relPath), { recursive: true, force: true });
}

export function readJson(...parts) {
  return JSON.parse(readFileSync(join(REPO, ...parts), 'utf8'));
}

export function writeJson(relPath, value) {
  writeFileSync(join(REPO, relPath), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Every file under a directory, repo-relative-ish, sorted — for byte-comparing builds. */
export function treeOf(absDir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push([relative(absDir, p).split(sep).join('/'), readFileSync(p)]);
    }
  };
  walk(absDir);
  return out;
}
