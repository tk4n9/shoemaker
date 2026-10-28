// The default team: what a round runs without a confirmed team. It mirrors
// run.sh's standard flow (one suggestion agent and max_builds builds, side by
// side), so showing it changes nothing about how rounds run.
export const DEFAULT_DESCRIPTIONS = {
  suggest: 'Find small features that fit DIRECTION.md and propose each with a concrete spec, for you to approve.',
  implement: 'Build the approved items in separate worktrees and land them through the merge gate.',
};

export function defaultRows(settings) {
  return [
    { id: 'suggestion', name: 'Suggestion', count: 1, description: DEFAULT_DESCRIPTIONS.suggest, builtin: 'suggest' },
    { id: 'implementation', name: 'Implementation', count: settings.maxBuilds, description: DEFAULT_DESCRIPTIONS.implement, builtin: 'implement' },
  ];
}

// What the page shows for a default role's interpreted columns.
export function defaultRole(row, settings) {
  return row.builtin === 'suggest'
    ? { capabilities: ['propose'], authority: 'advisory', model: settings.suggestModel || settings.model, effort: settings.suggestEffort || settings.effort }
    : { capabilities: ['build'], authority: 'advisory', model: settings.model, effort: settings.effort };
}

const key = (row) => JSON.stringify([row.id, row.name, row.count, row.description, row.builtin ?? null]);
export function sameRows(a, b) {
  return a.length === b.length && a.every((row, i) => key(row) === key(b[i]));
}
