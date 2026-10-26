#!/usr/bin/env node
// Feedback loop: syntax-check every source file, then run the test suite.
// Failures are printed as actionable messages. Exit non-zero on any failure.
// Run: npm run check
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['src', 'bin', 'scripts', 'test', 'public'];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (['.js', '.mjs'].includes(extname(p))) out.push(p);
  }
  return out;
}

let failed = 0;

// 1. Syntax check.
console.log('› Syntax check…');
for (const dir of DIRS) {
  let files;
  try { files = walk(join(ROOT, dir)); } catch { continue; }
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) {
      failed++;
      console.error(`  ✗ ${f.replace(ROOT + '/', '')}\n${r.stderr.trim().split('\n').map((l) => '    ' + l).join('\n')}`);
    }
  }
}
if (!failed) console.log('  ✓ all files parse');

// 2. Tests.
console.log('› Tests…');
const t = spawnSync(process.execPath, ['--test'], { cwd: ROOT, stdio: 'inherit' });
if (t.status !== 0) failed++;

if (failed) {
  console.error(`\n✗ check failed (${failed} problem${failed > 1 ? 's' : ''}). Fix the above and re-run \`npm run check\`.`);
  process.exit(1);
}
console.log('\n✓ check passed.');
