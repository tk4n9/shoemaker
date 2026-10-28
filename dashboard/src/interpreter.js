// The headless interpreter shared by the Team and Direction pages. It reads
// what the human wrote and returns JSON only: no tools, no MCP, no settings.
// Callers validate the JSON before anything is written.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EFFORTS, readTeamSettings } from './team-config.js';

const OUTPUT_LIMIT = 2 * 1024 * 1024;

export function readJSON(file, fallback = null) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
}

export function atomicJSON(file, value) {
  atomicWrite(file, JSON.stringify(value, null, 2) + '\n');
}

export function atomicWrite(file, text, mode = 0o600) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, text, { mode });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

export function conflict(message) {
  return Object.assign(new Error(message), { status: 409 });
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export function contextFile(state, name) {
  try { return readFileSync(join(state, name), 'utf8').slice(0, 100_000); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

export function parseTimeout(value) {
  const match = /^(\d+)([hms]?)$/.exec(value);
  const ms = match && Number(match[1]) * ({ h: 3_600_000, m: 60_000, s: 1000, '': 1000 }[match[2]]);
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > 2_147_483_647) {
    throw new Error(`APPLY_TIMEOUT must be a positive integer duration (h, m or s; at most 2147483647 ms), got '${value}'`);
  }
  return ms;
}

// apply_model / apply_effort, falling back to model / effort; APPLY_TIMEOUT.
export function interpreterSettings(state) {
  const settings = readTeamSettings(state);
  const model = settings.applyModel || settings.model;
  const effort = settings.applyEffort || settings.effort;
  if (effort && !EFFORTS.includes(effort)) {
    throw new Error(`${settings.applyEffort ? 'apply_effort' : 'effort'} must be low, medium, high, xhigh or max (got '${effort}')`);
  }
  return { settings, model, effort, timeoutMs: parseTimeout(settings.applyTimeout) };
}

// A directory lock with its owner's pid, so a stopped process can be detected.
// onStale runs when the owner is gone, before the lock is removed.
export class DirLock {
  constructor(dir, { busy = 'An interpretation is already running.', onStale = () => {} } = {}) {
    this.dir = dir;
    this.path = join(dir, '.interpret.lock');
    this.busy = busy;
    this.onStale = onStale;
  }

  held() {
    this.recover();
    return existsSync(this.path);
  }

  recover() {
    if (!existsSync(this.path)) return;
    const owner = readJSON(join(this.path, 'owner.json'));
    // Another process can observe the directory before its owner is written.
    if (!owner && Date.now() - statSync(this.path).mtimeMs < 5000) return;
    if (owner && alive(owner.pid)) return;
    this.onStale();
    rmSync(this.path, { recursive: true, force: true });
  }

  acquire() {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.recover();
    try { mkdirSync(this.path, { mode: 0o700 }); }
    catch (error) { if (error.code === 'EEXIST') throw conflict(this.busy); throw error; }
    try { atomicJSON(join(this.path, 'owner.json'), { pid: process.pid }); }
    catch (error) { this.release(); throw error; }
  }

  release() {
    rmSync(this.path, { recursive: true, force: true });
  }

  run(action) {
    this.acquire();
    try { return action(); } finally { this.release(); }
  }
}

// Runs one interpretation and resolves with its structured output. The prompt
// and the raw output are kept in logDir for the human to inspect.
export function interpret({ command = 'claude', prompt, schema, model, effort, timeoutMs, logDir }) {
  const args = ['--print', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', '', '--disable-slash-commands', '--safe-mode', '--permission-mode', 'dontAsk',
    '--no-session-persistence', '--output-format', 'json', '--json-schema', JSON.stringify(schema)];
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(logDir, 'prompt.md'), prompt, { mode: 0o600 });
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: logDir, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    let failure = '';
    let finished = false;
    const stop = () => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    };
    const timer = setTimeout(() => { failure = `Interpretation timed out after ${timeoutMs} ms.`; stop(); }, timeoutMs);
    const collect = (kind, chunk) => {
      if (kind === 'stdout') stdout += chunk;
      else stderr += chunk;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > OUTPUT_LIMIT) {
        failure = 'Interpretation output exceeded the size limit.';
        stdout = stdout.slice(0, OUTPUT_LIMIT);
        stderr = stderr.slice(0, OUTPUT_LIMIT);
        stop();
      }
    };
    child.stdout.on('data', (chunk) => collect('stdout', chunk));
    child.stderr.on('data', (chunk) => collect('stderr', chunk));
    child.stdin.on('error', () => {}); // exit before reading the prompt is handled below
    const finish = (code, spawnError) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        writeFileSync(join(logDir, 'stdout.json'), stdout, { mode: 0o600 });
        writeFileSync(join(logDir, 'stderr.log'), stderr, { mode: 0o600 });
        if (spawnError) throw new Error(`Could not start interpreter: ${spawnError.message}`);
        if (failure) throw new Error(failure);
        if (code !== 0) throw new Error(`Interpreter exited with code ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 1000)}` : '.'}`);
        const result = JSON.parse(stdout);
        if (result.is_error || (result.type === 'result' && result.subtype && result.subtype !== 'success')) {
          throw new Error(`Interpreter failed: ${String(result.result || result.subtype || 'unknown error').slice(0, 1000)}`);
        }
        if (!result.structured_output) throw new Error('Interpreter returned no structured output.');
        resolve(result.structured_output);
      } catch (error) {
        reject(error);
      }
    };
    child.on('error', (error) => finish(null, error));
    child.on('close', (code) => finish(code));
    child.stdin.end(prompt);
  });
}
