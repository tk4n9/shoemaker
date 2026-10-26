// Worktree metadata remains authoritative if an agent clears its environment.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export function agentWorktree() {
  try { return Boolean(execFileSync('git', ['config', '--get', 'shoemaker.role'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); }
  catch { return false; }
}

export function teamContext() {
  let file;
  try { file = execFileSync('git', ['config', '--get', 'shoemaker.teamContext'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* not a team worktree */ }
  file ||= process.env.SHOEMAKER_TEAM_CONTEXT;
  return file ? JSON.parse(readFileSync(file, 'utf8')) : null;
}
