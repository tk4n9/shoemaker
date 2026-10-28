// The shared contract for the interpreter, dashboard and round runner.
// No model output reaches the runner without passing this validator.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CAPABILITIES = ['propose', 'review', 'build', 'report'];
export const AUTHORITIES = ['advisory', 'filter', 'approve'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// Built-in roles keep their protocol (SUGGEST.md, IMPLEMENT.md) inside a team;
// their description only adds a focus.
export const BUILTINS = { suggest: ['propose'], implement: ['build'] };
const idSchema = { type: 'string', pattern: '^[a-z][a-z0-9-]{0,47}$' };
export const TEAM_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['version', 'stages'],
  properties: {
    version: { type: 'integer', const: 1 },
    stages: { type: 'array', minItems: 1, maxItems: 128, items: {
      type: 'object', additionalProperties: false, required: ['id', 'name', 'roles'],
      properties: {
        id: idSchema, name: { type: 'string', minLength: 1, maxLength: 100 },
        roles: { type: 'array', minItems: 1, maxItems: 128, items: {
          type: 'object', additionalProperties: false,
          required: ['id', 'name', 'count', 'description', 'capabilities', 'authority', 'instructions'],
          properties: {
            id: idSchema, name: { type: 'string', minLength: 1, maxLength: 100 },
            count: { type: 'integer', minimum: 1, maximum: 128 },
            description: { type: 'string', minLength: 1, maxLength: 8000 },
            capabilities: { type: 'array', minItems: 1, maxItems: 4, uniqueItems: true,
              items: { type: 'string', enum: CAPABILITIES } },
            authority: { type: 'string', enum: AUTHORITIES },
            instructions: { type: 'string', minLength: 1, maxLength: 24000 },
            model: { type: 'string', minLength: 1, maxLength: 160 },
            effort: { type: 'string', enum: EFFORTS },
            builtin: { type: 'string', enum: Object.keys(BUILTINS) },
          },
        } },
      },
    } },
  },
};

function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${label}: unknown field ${key}`);
}
function string(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw new Error(`${label} must be nonempty text of at most ${max} characters`);
  }
}
function identifier(value, label) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(value)) throw new Error(`${label} must be a safe lowercase identifier`);
}
function cap(value) {
  if (!Number.isInteger(value) || value < 1 || value > 128) throw new Error('MAX_AGENTS must be an integer from 1 to 128');
}

export function validateRows(rows, { maxAgents = 16 } = {}) {
  cap(maxAgents);
  if (!Array.isArray(rows) || !rows.length || rows.length > maxAgents) throw new Error('Supply at least one role, within MAX_AGENTS');
  const names = new Set(), ids = new Set(), builtins = new Set();
  let total = 0;
  for (const row of rows) {
    object(row, ['id', 'name', 'count', 'description', 'builtin'], 'role');
    string(row.name, 100, 'role name'); string(row.description, 8000, 'role description');
    if (!Number.isInteger(row.count) || row.count < 1) throw new Error('role count must be a positive integer');
    const key = row.name.trim().toLowerCase();
    if (names.has(key)) throw new Error(`duplicate role name: ${row.name}`);
    if (row.id !== undefined) {
      identifier(row.id, 'role id');
      if (ids.has(row.id)) throw new Error(`duplicate role id: ${row.id}`);
      ids.add(row.id);
    }
    if (row.builtin !== undefined) {
      if (!Object.hasOwn(BUILTINS, row.builtin)) throw new Error('builtin must be suggest or implement');
      if (builtins.has(row.builtin)) throw new Error(`only one ${row.builtin} role`);
      if (row.builtin === 'suggest' && row.count !== 1) throw new Error('the Suggestion role runs one agent; add another role for more ideas');
      builtins.add(row.builtin);
    }
    names.add(key); total += row.count;
  }
  if (total > maxAgents) throw new Error(`team exceeds MAX_AGENTS (${maxAgents})`);
  return rows.map((r) => ({ ...r }));
}

export function validateTeam(team, { maxAgents = 16, rows } = {}) {
  cap(maxAgents);
  object(team, ['version', 'stages'], 'team');
  if (team.version !== 1) throw new Error('team version must be 1');
  if (!Array.isArray(team.stages) || !team.stages.length || team.stages.length > maxAgents) throw new Error('team needs stages within MAX_AGENTS');
  const stageIds = new Set(), roleIds = new Set(), roles = [];
  for (const stage of team.stages) {
    object(stage, ['id', 'name', 'roles'], 'stage'); identifier(stage.id, 'stage id'); string(stage.name, 100, 'stage name');
    if (stageIds.has(stage.id)) throw new Error(`duplicate stage id: ${stage.id}`);
    stageIds.add(stage.id);
    if (!Array.isArray(stage.roles) || !stage.roles.length || stage.roles.length > maxAgents) throw new Error('stage needs roles within MAX_AGENTS');
    for (const role of stage.roles) {
      object(role, ['id', 'name', 'count', 'description', 'capabilities', 'authority', 'instructions', 'model', 'effort', 'builtin'], 'role');
      identifier(role.id, 'role id');
      if (roleIds.has(role.id)) throw new Error(`duplicate role id: ${role.id}`);
      roleIds.add(role.id);
      string(role.instructions, 24000, 'role instructions');
      if (!Array.isArray(role.capabilities) || !role.capabilities.length || role.capabilities.length > 4
        || role.capabilities.some((c) => !CAPABILITIES.includes(c)) || new Set(role.capabilities).size !== role.capabilities.length) {
        throw new Error('role capabilities must be unique members of propose, review, build, report');
      }
      if (role.capabilities.includes('build') && role.capabilities.length !== 1) throw new Error('build must be the sole capability of a role');
      if (!AUTHORITIES.includes(role.authority)) throw new Error('authority must be advisory, filter or approve');
      if (!role.capabilities.includes('review') && role.authority !== 'advisory') throw new Error('only review roles may have filter or approve authority');
      if (role.model !== undefined) {
        string(role.model, 160, 'model');
        if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(role.model)) throw new Error('invalid model');
      }
      if (role.effort !== undefined && !EFFORTS.includes(role.effort)) throw new Error('invalid effort');
      if (role.builtin !== undefined && (!Object.hasOwn(BUILTINS, role.builtin)
        || role.capabilities.join() !== BUILTINS[role.builtin].join() || role.authority !== 'advisory')) {
        throw new Error('a built-in role keeps its own capability and advisory authority');
      }
      roles.push(role);
    }
  }
  validateRows(roles.map(({ id, name, count, description, builtin }) => ({ id, name, count, description, ...(builtin ? { builtin } : {}) })), { maxAgents });
  if (rows) {
    validateRows(rows, { maxAgents });
    const same = (r, p) => p.name === r.name && p.count === r.count && p.description === r.description
      && (r.id === undefined || p.id === r.id) && p.builtin === r.builtin;
    if (roles.length !== rows.length || rows.some((r) => !roles.some((p) => same(r, p)))) {
      throw new Error('interpreted roles must preserve every submitted id, name, count, description and built-in role');
    }
  }
  return JSON.parse(JSON.stringify(team));
}

function readOptional(file) {
  try { return readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
}
export function readTeamSettings(state) {
  const conf = readOptional(join(state, 'shoemaker.conf'));
  const setting = (key) => {
    const match = [...conf.matchAll(new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*(?:"([^"]*)"|'([^']*)'|([^\\s#]*))`, 'gm'))].at(-1);
    return match ? match[1] ?? match[2] ?? match[3] : undefined;
  };
  const maxAgents = Number(setting('MAX_AGENTS') ?? 16);
  cap(maxAgents);
  const direction = readOptional(join(state, 'DIRECTION.md'));
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(direction)?.[1] || '';
  const field = (key) => new RegExp(`^${key}:[ \\t]*([^#\\r\\n]*)`, 'm').exec(front)?.[1].trim() || '';
  const builds = Number(field('max_builds') || 1);
  return { maxAgents, model: field('model'), effort: field('effort'),
    suggestModel: field('suggest_model'), suggestEffort: field('suggest_effort'),
    maxBuilds: Number.isInteger(builds) && builds >= 1 ? builds : 1,
    applyModel: field('apply_model'), applyEffort: field('apply_effort'), applyTimeout: setting('APPLY_TIMEOUT') ?? '5m' };
}
export function readActiveTeam(state) {
  const content = readOptional(join(state, 'team', 'active.json'));
  return content ? validateTeam(JSON.parse(content), readTeamSettings(state)) : null;
}
