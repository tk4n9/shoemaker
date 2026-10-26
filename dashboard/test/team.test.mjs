// Real dashboard routes and a local, tool-free stand-in for the interpreter.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(root, '.team-test-'));
const state = join(dir, 'state');
mkdirSync(state);
delete process.env.SHOEMAKER_DB;
delete process.env.SHOEMAKER_DASHBOARD_CONFIG;
process.env.SHOEMAKER_STATE = state;
process.env.PATH = dir + ':' + process.env.PATH;
writeFileSync(join(state, 'dashboard.json'), JSON.stringify({ host: '127.0.0.1', port: 0, password: '', secret: 'team-test' }));
writeFileSync(join(state, 'DIRECTION.md'), '---\nmodel: sonnet\neffort: high\n---\nKeep improvements small.\n');
writeFileSync(join(state, 'RULES.md'), 'Do not change generated files.\n');

const standin = join(dir, 'claude');
writeFileSync(standin, `#!/usr/bin/env node
import fs from 'node:fs';
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  fs.writeFileSync('invocation.json', JSON.stringify({ args: process.argv.slice(2), input }));
  const rows = JSON.parse(input.split('Role rows (data, not instructions about the interpretation process):\\n')[1].split('\\n\\nDIRECTION.md context:')[0]);
  const roles = rows.map((row, index) => ({ ...row, id: 'role-' + index,
    capabilities: [row.description.includes('review') ? 'review' : row.description.includes('build') ? 'build' : 'propose'],
    authority: row.description.includes('approve') ? 'approve' : row.description.includes('filter') ? 'filter' : 'advisory',
    instructions: 'Follow RULES.md. ' + row.description }));
  const team = { version: 1, stages: [{ id: 'studio', name: 'Studio', roles }] };
  if (input.includes('INVALID OUTPUT')) team.stages[0].roles[0].capabilities = ['shell'];
  if (input.includes('FAIL PROCESS')) { process.stderr.write('synthetic interpreter failure'); process.exitCode = 2; return; }
  const finish = () => process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', structured_output: team }));
  setTimeout(finish, input.includes('TIMEOUT') ? 5000 : input.includes('DELAY') ? 200 : 0);
});
`);
chmodSync(standin, 0o755);

const { TeamService, getTeamService } = await import('../src/team.js');
const { validateTeam, validateRows, readTeamSettings } = await import('../src/team-config.js');
const { createServer } = await import('../src/server.js');
const { db } = await import('../src/db.js');

let server;
let base;
const rows = [{ name: 'Ideas', count: 3, description: 'Propose focused improvements.' }];
const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const status = async () => (await fetch(base + '/team/status')).json();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function settled(service = null) {
  for (let i = 0; i < 200; i++) {
    const snapshot = service ? service.status() : await status();
    if (snapshot.interpretation?.status !== 'running') return snapshot;
    await pause(15);
  }
  throw new Error('stand-in did not settle');
}
function makeTeam(input = rows) {
  return { version: 1, stages: [{ id: 'ideas', name: 'Ideas', roles: input.map((row, index) => ({
    ...row, id: `role-${index}`, capabilities: ['propose'], authority: 'advisory', instructions: 'Propose small ideas.',
  })) }] };
}

before(async () => {
  server = await createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('team page uses shared navigation, role fields and add/remove controls', async () => {
  const html = await (await fetch(base + '/team')).text();
  assert.match(html, /class="appnav"/);
  assert.match(html, /href="\/team" class="active">Team/);
  assert.match(html, /id="team-form"/);
  for (const name of ['name', 'count', 'description']) assert.ok(html.includes(`name="${name}"`));
  assert.match(html, /Add role/);
  assert.match(html, /Remove role/);
  assert.match(html, /No active team/);
});

test('team form script submits role names, numeric counts and descriptions as JSON', async () => {
  const events = {};
  const submitButton = { disabled: false };
  const form = { addEventListener: (event, handler) => events[event] = handler, querySelector: () => submitButton };
  const fields = { name: { value: 'Reviewers' }, count: { value: '2' }, description: { value: 'Discuss and review each idea.' } };
  const row = { querySelector: (selector) => fields[selector.match(/name="([^"]+)"/)[1]] };
  const list = { addEventListener() {}, querySelectorAll: () => [row] };
  const page = { dataset: { teamRunning: '0' }, querySelectorAll: () => [] };
  const elements = { '#team-page': page, '#team-form': form, '#team-roles': list,
    '#team-error': {}, '#team-add': { addEventListener() {} } };
  let sent;
  let reloaded = false;
  runInNewContext(readFileSync(join(root, 'public', 'team.js'), 'utf8'), {
    document: { body: { dataset: { base: '/scratch' } }, querySelector: (selector) => elements[selector] },
    fetch: async (url, options) => { sent = { url, options }; return { ok: true, json: async () => ({}) }; },
    location: { reload: () => { reloaded = true; } },
  });
  let prevented = false;
  await events.submit({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(sent.url, '/scratch/team/apply');
  assert.equal(sent.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(sent.options.body), { rows: [{ name: 'Reviewers', count: 2, description: 'Discuss and review each idea.' }] });
  assert.equal(reloaded, true);
});

test('Apply starts a background interpreter and exposes a validated preview', async () => {
  const response = await post('/team/apply', { rows });
  assert.equal(response.status, 202);
  const started = await response.json();
  assert.equal(started.interpretation.status, 'running');
  const snapshot = await settled();
  assert.equal(snapshot.interpretation.status, 'ready');
  assert.equal(snapshot.active, null);
  assert.equal(snapshot.proposed.stages[0].roles[0].count, 3);
  assert.equal(existsSync(join(state, 'team', 'active.json')), false);
  const html = await (await fetch(base + '/team')).text();
  assert.match(html, /Preview ready/);
  assert.match(html, /Studio/);
  assert.match(html, /Capabilities/);
  assert.match(html, /Authority/);
  assert.match(html, /advisory/);
  assert.match(html, /Generated instructions/);
  assert.match(html, /data-team-action="confirm"/);
  assert.match(html, /data-team-action="discard"/);
});

test('interpreter has no tools, inherited settings or MCP and receives project context', async () => {
  const snapshot = await status();
  const log = join(state, snapshot.interpretation.logs, 'invocation.json');
  const { args, input } = JSON.parse(readFileSync(log, 'utf8'));
  const value = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(value('--tools'), '');
  assert.deepEqual(JSON.parse(value('--mcp-config')), { mcpServers: {} });
  assert.equal(value('--setting-sources'), '');
  for (const flag of ['--safe-mode', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) assert.ok(args.includes(flag));
  assert.equal(value('--permission-mode'), 'dontAsk');
  assert.equal(value('--model'), 'sonnet');
  assert.equal(value('--effort'), 'high');
  assert.equal(snapshot.interpretation.model, 'sonnet');
  assert.equal(snapshot.interpretation.effort, 'high');
  assert.equal(value('--output-format'), 'json');
  assert.equal(JSON.parse(value('--json-schema')).additionalProperties, false);
  assert.match(input, /Keep improvements small/);
  assert.match(input, /Do not change generated files/);
});

for (const [name, baseModel, baseEffort, overrides, model, effort] of [
  ['apply overrides', 'sonnet', 'high', 'apply_model: opus\napply_effort: xhigh\n', 'opus', 'xhigh'],
  ['blank apply overrides', 'sonnet', 'high', 'apply_model:\napply_effort: # inherit\n', 'sonnet', 'high'],
  ['model override alone', 'sonnet', 'high', 'apply_model: provider/custom@preview\n', 'provider/custom@preview', 'high'],
  ['effort override alone', 'sonnet', 'high', 'apply_effort: max\n', 'sonnet', 'max'],
  ['all blank settings', '', '', 'apply_model:\napply_effort:\n', '', ''],
  ['all absent settings', '', '', '', '', ''],
]) {
  test(`interpreter uses ${name} and records the actual settings`, async () => {
    const configState = join(dir, name.replaceAll(' ', '-'));
    mkdirSync(configState);
    const direction = join(configState, 'DIRECTION.md');
    const base = name === 'all absent settings' ? '' : `model: ${baseModel}\neffort: ${baseEffort}\n`;
    writeFileSync(direction, `---\n${base}${overrides}---\n`);
    const service = new TeamService({ state: configState, command: standin });
    const started = service.apply(rows);
    assert.equal(started.model, model || 'default');
    assert.equal(started.effort, effort || 'default');
    writeFileSync(direction, '---\nmodel: haiku\neffort: low\napply_model: changed\n---\n');
    const snapshot = await settled(service);
    assert.equal(snapshot.interpretation.status, 'ready');
    const { args, input } = JSON.parse(readFileSync(join(configState, started.logs, 'invocation.json'), 'utf8'));
    for (const [flag, value] of [['--model', model], ['--effort', effort]]) {
      if (value) assert.equal(args[args.indexOf(flag) + 1], value);
      else assert.ok(!args.includes(flag));
    }
    assert.ok(input.includes(`Otherwise all roles inherit DIRECTION.md model/effort (${baseModel || 'Claude default'}/${baseEffort || 'Claude default'}).`));
    const record = JSON.parse(readFileSync(join(configState, 'team', 'interpretation.json'), 'utf8'));
    assert.equal(record.model, model || 'default');
    assert.equal(record.effort, effort || 'default');
    const { teamPage } = await import('../src/features/team.js');
    assert.ok(teamPage(snapshot).includes(`Model: ${model || 'default'}; effort: ${effort || 'default'}.`));
  });
}

test('invalid Apply settings are rejected before spawning and preserve the active team and preview', (t) => {
  const invalidState = join(dir, 'invalid-apply-settings');
  const teamDir = join(invalidState, 'team');
  mkdirSync(teamDir, { recursive: true });
  const saved = {
    'active.json': JSON.stringify(makeTeam()),
    'proposed.json': JSON.stringify(makeTeam()),
    'interpretation.json': JSON.stringify({ id: 'previous', status: 'ready', model: 'sonnet', effort: 'high' }),
  };
  for (const [file, content] of Object.entries(saved)) writeFileSync(join(teamDir, file), content);
  const service = new TeamService({ state: invalidState, command: standin });
  const run = t.mock.method(service, 'run', () => assert.fail('invalid settings must not spawn'));
  const invalid = [
    ['model: sonnet\neffort: high\napply_effort: extreme\n', '', /apply_effort must be low, medium, high, xhigh or max/],
    ['effort: invalid\n', '', /effort must be/],
    ...['', 'garbage', '-1s', '0s', '1.5m', '2d', '999999999999h'].map((value) => ['', `APPLY_TIMEOUT="${value}"\n`, /APPLY_TIMEOUT must be/]),
  ];
  for (const [direction, conf, error] of invalid) {
    writeFileSync(join(invalidState, 'DIRECTION.md'), `---\n${direction}---\n`);
    writeFileSync(join(invalidState, 'shoemaker.conf'), conf);
    assert.throws(() => service.apply(rows), error);
    assert.equal(run.mock.callCount(), 0);
    assert.equal(service.job, null);
    assert.equal(existsSync(join(teamDir, '.interpret.lock')), false);
    assert.equal(existsSync(join(teamDir, 'interpretation-runs')), false);
    for (const [file, content] of Object.entries(saved)) assert.equal(readFileSync(join(teamDir, file), 'utf8'), content);
    assert.deepEqual(service.status().active, makeTeam());
  }
});

test('APPLY_TIMEOUT defaults to five minutes and accepts h, m, s and bare seconds', async (t) => {
  const scheduled = [];
  const setTimer = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    scheduled.push(ms);
    return setTimer(callback, ms, ...args);
  });
  for (const [index, conf, timeout] of [
    [0, '', 300_000],
    [1, 'APPLY_TIMEOUT="2h" # hours\n', 7_200_000],
    [2, "APPLY_TIMEOUT='3m'\n", 180_000],
    [3, 'APPLY_TIMEOUT=4s\n', 4000],
    [4, 'APPLY_TIMEOUT=2m\nAPPLY_TIMEOUT=5\n', 5000],
  ]) {
    const configState = join(dir, `duration-${index}`);
    mkdirSync(configState);
    const service = new TeamService({ state: configState, command: standin });
    writeFileSync(join(configState, 'shoemaker.conf'), conf);
    service.apply(rows);
    assert.equal(scheduled.at(-1), timeout);
    assert.equal((await settled(service)).interpretation.status, 'ready');
  }
});

test('APPLY_TIMEOUT kills the interpreter at the configured deadline', async () => {
  const timeoutState = join(dir, 'configured-timeout');
  mkdirSync(timeoutState);
  const service = new TeamService({ state: timeoutState, command: standin });
  writeFileSync(join(timeoutState, 'shoemaker.conf'), 'APPLY_TIMEOUT=1s\n');
  service.apply([{ ...rows[0], description: 'Propose focused improvements. TIMEOUT' }]);
  const snapshot = await settled(service);
  assert.equal(snapshot.interpretation.status, 'failed');
  assert.match(snapshot.interpretation.error, /timed out after 1000 ms/);
  assert.equal(snapshot.proposed, null);
  assert.equal(service.job, null);
});

test('Confirm atomically activates the preview and refuses a stale preview', async () => {
  const snapshot = await status();
  const response = await post('/team/confirm', { id: snapshot.interpretation.id });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(readFileSync(join(state, 'team', 'active.json'), 'utf8')), snapshot.proposed);
  const current = await status();
  assert.equal(current.interpretation.status, 'confirmed');
  assert.equal(current.proposed, null);
  assert.deepEqual(current.active, snapshot.proposed);
  assert.equal((await post('/team/confirm', { id: snapshot.interpretation.id })).status, 409);
});

test('Discard removes only the proposal and leaves the active team unchanged', async () => {
  const active = readFileSync(join(state, 'team', 'active.json'), 'utf8');
  await post('/team/apply', { rows: [{ name: 'Review', count: 2, description: 'Discuss and review; filter unsuitable ideas.' }] });
  const snapshot = await settled();
  assert.equal(snapshot.proposed.stages[0].roles[0].authority, 'filter');
  const response = await post('/team/discard', { id: snapshot.interpretation.id });
  assert.equal(response.status, 200);
  assert.equal(existsSync(join(state, 'team', 'proposed.json')), false);
  assert.equal(readFileSync(join(state, 'team', 'active.json'), 'utf8'), active);
  assert.equal((await status()).interpretation.status, 'discarded');
});

test('a second Apply and confirm/discard are refused while interpretation runs', async () => {
  const delayed = [{ ...rows[0], description: 'Propose focused improvements. DELAY' }];
  assert.equal((await post('/team/apply', { rows: delayed })).status, 202);
  const snapshot = await status();
  assert.equal((await post('/team/apply', { rows })).status, 409);
  assert.equal((await post('/team/confirm', { id: snapshot.interpretation.id })).status, 409);
  assert.equal((await post('/team/discard', { id: snapshot.interpretation.id })).status, 409);
  const finished = await settled();
  await post('/team/discard', { id: finished.interpretation.id });
});

test('invalid interpreter output fails and preserves the active configuration', async () => {
  const active = readFileSync(join(state, 'team', 'active.json'), 'utf8');
  await post('/team/apply', { rows: [{ ...rows[0], description: 'Propose focused improvements. INVALID OUTPUT' }] });
  const snapshot = await settled();
  assert.equal(snapshot.interpretation.status, 'failed');
  assert.match(snapshot.interpretation.error, /capabilities/);
  assert.equal(snapshot.proposed, null);
  assert.equal(readFileSync(join(state, 'team', 'active.json'), 'utf8'), active);
  assert.match(await (await fetch(base + '/team')).text(), /Interpretation failed/);
});

test('interpreter failure surfaces its error and permits the next Apply', async () => {
  await post('/team/apply', { rows: [{ ...rows[0], description: 'Propose focused improvements. FAIL PROCESS' }] });
  const snapshot = await settled();
  assert.equal(snapshot.interpretation.status, 'failed');
  assert.match(snapshot.interpretation.error, /synthetic interpreter failure/);
  assert.equal(existsSync(join(state, 'team', '.interpret.lock')), false);
});

test('timed-out interpretation is killed, reports an error and preserves active state', async () => {
  const timeoutState = join(dir, 'timeout');
  mkdirSync(timeoutState);
  writeFileSync(join(timeoutState, 'shoemaker.conf'), 'APPLY_TIMEOUT=2h\n');
  mkdirSync(join(timeoutState, 'team'));
  const active = makeTeam();
  writeFileSync(join(timeoutState, 'team', 'active.json'), JSON.stringify(active));
  const service = new TeamService({ state: timeoutState, command: standin, timeoutMs: 80 });
  service.apply([{ ...rows[0], description: 'Propose focused improvements. TIMEOUT' }]);
  const snapshot = await settled(service);
  assert.equal(snapshot.interpretation.status, 'failed');
  assert.match(snapshot.interpretation.error, /timed out after 80 ms/);
  assert.deepEqual(snapshot.active, active);
  assert.equal(snapshot.proposed, null);
  assert.equal(service.job, null);
});

test('Apply validates input before starting an interpreter', async () => {
  for (const bad of [[], [{ ...rows[0], count: 0 }], [{ ...rows[0], count: 1.5 }], [{ ...rows[0], count: 17 }], [{ ...rows[0], shell: 'bad' }], [rows[0], rows[0]]]) {
    assert.equal((await post('/team/apply', { rows: bad })).status, 400);
  }
  assert.equal((await post('/team/apply', { rows, unexpected: true })).status, 400);
});

test('team mutation routes retain dashboard same-origin protection', async () => {
  const response = await fetch(base + '/team/apply', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://example.invalid' }, body: JSON.stringify({ rows }),
  });
  assert.equal(response.status, 403);
});

test('preview is revalidated at Confirm if the cap or proposal changes', async () => {
  await post('/team/apply', { rows });
  const snapshot = await settled();
  writeFileSync(join(state, 'shoemaker.conf'), 'MAX_AGENTS=2\n');
  assert.equal((await post('/team/confirm', { id: snapshot.interpretation.id })).status, 409);
  rmSync(join(state, 'shoemaker.conf'));
  const proposal = snapshot.proposed;
  proposal.stages[0].roles[0].instructions = '';
  writeFileSync(join(state, 'team', 'proposed.json'), JSON.stringify(proposal));
  assert.equal((await post('/team/confirm', { id: snapshot.interpretation.id })).status, 409);
});

test('a stopped dashboard leaves a recoverable failed interpretation', () => {
  const recoveryState = join(dir, 'recovery');
  mkdirSync(join(recoveryState, 'team', '.interpret.lock'), { recursive: true });
  writeFileSync(join(recoveryState, 'team', '.interpret.lock', 'owner.json'), JSON.stringify({ pid: 2147483647 }));
  writeFileSync(join(recoveryState, 'team', 'interpretation.json'), JSON.stringify({ id: 'old', status: 'running' }));
  const service = new TeamService({ state: recoveryState, command: standin });
  assert.match(service.status().interpretation.error, /Dashboard stopped/);
  assert.equal(existsSync(join(recoveryState, 'team', '.interpret.lock')), false);
});

test('a second dashboard cannot Apply, Confirm or Discard inside another mutation', () => {
  const sharedState = join(dir, 'shared');
  const first = new TeamService({ state: sharedState, command: standin });
  const second = new TeamService({ state: sharedState, command: standin });
  first.withLock(() => {
    assert.equal(first.status().interpretation, null);
    assert.throws(() => second.apply(rows), /already running/);
    assert.throws(() => second.confirm('old'), /already running/);
    assert.throws(() => second.discard('old'), /already running/);
  });
  assert.equal(existsSync(join(sharedState, 'team', '.interpret.lock')), false);
});

test('missing interpreter reports failure and releases the lock', async () => {
  const missingState = join(dir, 'missing-command');
  const service = new TeamService({ state: missingState, command: join(dir, 'does-not-exist') });
  service.apply(rows);
  const snapshot = await settled(service);
  assert.equal(snapshot.interpretation.status, 'failed');
  assert.match(snapshot.interpretation.error, /Could not start interpreter/);
  assert.equal(existsSync(join(missingState, 'team', '.interpret.lock')), false);
  assert.equal(service.job, null);
});

test('shared validation permits custom stages and review authority, but rejects unknown fields and powers', () => {
  const team = makeTeam([{ name: 'Reviewers', count: 2, description: 'review and approve useful ideas' }]);
  const role = team.stages[0].roles[0];
  role.capabilities = ['review', 'report'];
  role.authority = 'approve';
  assert.deepEqual(validateTeam(team), team);
  for (const change of [
    (t) => { t.extra = true; },
    (t) => { t.stages[0].extra = true; },
    (t) => { t.stages[0].roles[0].extra = true; },
    (t) => { t.stages[0].roles[0].capabilities = ['shell']; },
    (t) => { t.stages[0].roles[0].capabilities = ['build', 'review']; },
    (t) => { t.stages[0].roles[0].capabilities = ['propose']; },
    (t) => { t.stages[0].roles[0].count = -1; },
    (t) => { t.stages[0].id = '../outside'; },
    (t) => { t.stages[0].roles[0].model = '--bad-flag'; },
    (t) => { t.stages[0].roles[0].effort = 'unbounded'; },
  ]) {
    const copy = structuredClone(team);
    change(copy);
    assert.throws(() => validateTeam(copy));
  }
});

test('shared validation preserves the submitted roles and applies the cap', () => {
  const team = makeTeam();
  assert.deepEqual(validateTeam(team, { rows }), team);
  assert.throws(() => validateTeam(team, { rows: [{ ...rows[0], count: 4 }] }), /preserve/);
  assert.throws(() => validateTeam(team, { maxAgents: 2 }), /MAX_AGENTS/);
  assert.throws(() => validateRows([{ ...rows[0], count: '3' }]), /integer/);
  assert.deepEqual(readTeamSettings(dir), { maxAgents: 16, model: '', effort: '', applyModel: '', applyEffort: '', applyTimeout: '5m' });
});

test('blank DIRECTION model and effort inherit defaults without consuming following fields', () => {
  const defaults = join(dir, 'defaults');
  mkdirSync(defaults);
  writeFileSync(join(defaults, 'DIRECTION.md'), '---\nmodel:\neffort:\nsuggest_model: haiku\n---\n');
  assert.deepEqual(readTeamSettings(defaults), { maxAgents: 16, model: '', effort: '', applyModel: '', applyEffort: '', applyTimeout: '5m' });
});

test('team page escapes generated text and unavailable state gives a useful message', async () => {
  const { teamPage } = await import('../src/features/team.js');
  const snapshot = getTeamService().status();
  const team = makeTeam();
  team.stages[0].roles[0].instructions = '<script>bad()</script>';
  const html = teamPage({ ...snapshot, active: team, proposed: null });
  assert.ok(html.includes('&lt;script&gt;bad()&lt;/script&gt;'));
  assert.ok(!html.includes('<script>bad()'));
  const legacy = teamPage({ ...snapshot, interpretation: { status: 'ready' } });
  assert.match(legacy, /id="team-status">Preview ready\.[^<]*confirming\.<\/p>/);
  const recorded = teamPage({ ...snapshot, interpretation: { status: 'ready', model: '<script>bad()</script>', effort: 'high' } });
  assert.ok(recorded.includes('Model: &lt;script&gt;bad()&lt;/script&gt;; effort: high.'));
  const unavailable = new TeamService().status();
  assert.match(teamPage(unavailable), /Set SHOEMAKER_STATE/);
  assert.throws(() => new TeamService().apply(rows), /SHOEMAKER_STATE/);
});
