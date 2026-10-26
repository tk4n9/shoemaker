// Where an item stands, shown the same way on every page: a seam of five
// stitches (idea, approved, building, your merge, shipped) and one status word.
// Items that wait for the human are marked "yours": the thread colour means
// "your turn" and nothing else.

const STAGES = ['idea', 'approved', 'building', 'your merge', 'shipped'];
const STEP = { proposed: 1, approved: 2, in_progress: 3, failed: 3, review: 4, shipped: 5, archived: 0 };

export function standing(t, nextId) {
  switch (t.status) {
    case 'proposed': return { word: 'To review', yours: true };
    case 'approved': return { word: t.id === nextId ? 'Next up' : t.ready ? 'Ready' : 'Waiting', yours: false };
    case 'in_progress': return { word: 'Building', yours: false };
    case 'review': return { word: 'Your merge', yours: true };
    case 'failed': return { word: 'Failed', yours: true };
    case 'shipped': return { word: 'Shipped', yours: false };
    case 'archived': return { word: 'Archived', yours: false };
    default: return { word: t.status, yours: false };
  }
}

export const isYours = (t) => ['proposed', 'review', 'failed'].includes(t.status);

// The stitches are decoration for sighted readers; the word carries the status.
export function seam(t, nextId) {
  const step = STEP[t.status] ?? 0;
  const s = standing(t, nextId);
  const stitch = (i) => {
    if (i < step) return '<i class="done"></i>';
    if (i === step) return `<i class="${t.status === 'failed' ? 'cut' : 'now'}"></i>`;
    return '<i></i>';
  };
  return `<span class="seam${s.yours ? ' yours' : ''}" aria-hidden="true" title="${STAGES.join(' → ')}">${
    [1, 2, 3, 4, 5].map(stitch).join('')}</span><span class="state${s.yours ? ' yours' : ''}">${s.word}</span>`;
}
