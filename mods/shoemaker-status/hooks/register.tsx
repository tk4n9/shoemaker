import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Item, Project, Snapshot, Stats } from '../types'

const PANE = 'shoemaker'
const TITLE = 'Shoemaker'
// Change the tag when Snapshot's fields change: it declines what an earlier
// version stored, which outlives a reload.
const snapshot = atom(
  { plugin: 'shoemaker-status', key: 'snapshot' } as const,
  null,
  { shape: 'snapshot-1' },
)
// The person closed the pane this session: it is not opened again unasked.
const isDismissed = atom(
  { plugin: 'shoemaker-status', key: 'isDismissed' } as const,
  false,
)
// Which projects are shown, by name (null: all). $.store holds the choice for
// every session; this mirrors it for the pane.
const shown = atom({ plugin: 'shoemaker-status', key: 'shown' } as const, null)

type Engine = EngineInterface

// ── reading ──────────────────────────────────────────────────────────────

const num = (v: string | number | undefined) =>
  typeof v === 'number' && v > 0 ? v : undefined

export const isRunning = (p: Project) =>
  ['active', 'activating', 'deactivating', 'reloading'].includes(
    String(p.round?.ActiveState ?? ''),
  )

const parseOffset = (z: string) => {
  const m = /^([+-])(\d\d)(\d\d)$/.exec(z)
  if (!m) return 0
  const minutes = Number(m[2]) * 60 + Number(m[3])
  return m[1] === '-' ? -minutes : minutes
}

const pad = (n: number) => String(n).padStart(2, '0')

// A time on the host's clock: "23:30", or "10-30 03:30" when not within a day.
const when = (seconds: number, snap: Snapshot) => {
  const d = new Date(seconds * 1000 + snap.offsetMinutes * 60_000)
  const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  return Math.abs(seconds * 1000 - snap.at) < 86_400_000
    ? hm
    : `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${hm}`
}

export const span = (ms: number) => {
  const m = Math.round(Math.abs(ms) / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  return `${Math.floor(h / 24)}d`
}

export const roundPhrase = (p: Project, snap: Snapshot) => {
  if (isRunning(p)) {
    const start = num(p.round?.ExecMainStartTimestamp)
    return `round running${start ? ` ${span(snap.at - start * 1000)}` : ''}`
  }
  if (p.direction.enabled === 'false') return 'paused'
  if (!p.timer) return 'not scheduled'
  if (p.timer.ActiveState !== 'active') return `timer ${p.timer.ActiveState}`
  const next = num(p.timer.NextElapseUSecRealtime)
  return next ? `next ${when(next, snap)}` : 'idle'
}

const counts = (s: Stats | null) => {
  if (!s) return []
  const parts: string[] = []
  if (s.in_progress) parts.push(`${s.in_progress} building`)
  if (s.proposed) parts.push(`${s.proposed} to review`)
  if (s.review) parts.push(`${s.review} to merge`)
  if (s.failed) parts.push(`${s.failed} failed`)
  if (s.ready) parts.push(`${s.ready} ready`)
  return parts
}

export const summary = (snap: Snapshot) =>
  snap.projects
    .map(p => `${p.project}: ${[roundPhrase(p, snap), ...counts(p.stats)].join(' · ')}`)
    .join('  │  ')

const statusText = (snap: Snapshot) =>
  snap.projects.length === 0 ? undefined : `👞 ${summary(snap)}`

const isShown = (p: Project, names: readonly string[] | null) =>
  names === null || names.includes(p.project)

// The snapshot as the status line and the toasts see it: the shown projects.
const visible = (snap: Snapshot, names: readonly string[] | null): Snapshot => ({
  ...snap,
  projects: snap.projects.filter(p => isShown(p, names)),
})

// What changed between two reads, said once as a toast.
export const changes = (prev: Snapshot | null, next: Snapshot) => {
  if (!prev) return []
  const lines: string[] = []
  for (const p of next.projects) {
    const before = prev.projects.find(q => q.state === p.state)
    if (!before) continue
    const started = !isRunning(before) && isRunning(p)
    const finished =
      !isRunning(p) && (isRunning(before) || before.latest !== p.latest)
    if (started) lines.push(`👞 ${p.project}: round ${p.latest} started`)
    if (finished) {
      const d = delta(before.stats, p.stats)
      lines.push(`👞 ${p.project}: round ${p.latest} finished${d ? `: ${d}` : ''}`)
    }
  }
  return lines
}

const delta = (a: Stats | null, b: Stats | null) => {
  if (!a || !b) return ''
  const parts: string[] = []
  const more = (n: number, words: string) => n > 0 && parts.push(`+${n} ${words}`)
  more(b.shipped - a.shipped, 'shipped')
  more(b.review - a.review, 'to merge')
  more(b.failed - a.failed, 'failed')
  more(b.proposed - a.proposed, 'to review')
  return parts.join(', ')
}

const within = (dir: string, root: string) =>
  root !== '' && (dir === root || dir.startsWith(root.endsWith('/') ? root : `${root}/`))

// ── refreshing ───────────────────────────────────────────────────────────

// The session's working directory, where a project not yet installed is found.
let cwd = ''
let pending: Promise<Snapshot> | null = null
// `/shoemaker off`, kept in $.store across sessions: no status line, no
// background reads, no toasts. `/shoemaker` still opens the pane on request.
let isOff = false

async function collect($: Engine): Promise<Snapshot> {
  const at = await $.clock.now()
  const failed = (error: string): Snapshot => ({ at, offsetMinutes: 0, projects: [], error })
  try {
    const ran = await $.process.run(
      ['bash', `${$.plugin.root}/scripts/collect.sh`, cwd],
      { timeoutMs: 60_000 },
    )
    if (ran.exitCode !== 0) {
      const why = ran.stderr.trim().split('\n').pop() ?? ''
      return failed(`the status script exited ${ran.exitCode}${why ? `: ${why}` : ''}`)
    }
    const out = JSON.parse(ran.stdout) as { offset: string; projects: Project[] }
    return { at, offsetMinutes: parseOffset(out.offset), projects: out.projects, error: null }
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err))
  }
}

// The selection as $.store keeps it, mirrored into the session's state when
// another session changed it.
async function loadShown($: Engine): Promise<string[] | null> {
  const kept = await $.store.get('shown')
  const names = Array.isArray(kept) ? kept.filter((n): n is string => typeof n === 'string') : null
  if (JSON.stringify(names) !== JSON.stringify(await read($, shown))) {
    await update($, shown, () => names)
  }
  return names
}

async function saveShown($: Engine, names: string[] | null) {
  if (names === null) await $.store.delete('shown')
  else await $.store.set('shown', names)
  await update($, shown, () => names)
  const snap = await read($, snapshot)
  if (snap && !isOff) $.ui.status(statusText(visible(snap, names)))
}

async function readAgain($: Engine): Promise<Snapshot> {
  try {
    const prev = await read($, snapshot)
    let next = await collect($)
    // A failed read keeps what was last known, and says why.
    if (next.error && prev) next = { ...prev, error: next.error }
    await update($, snapshot, () => next)
    if (isOff) return next
    const names = await loadShown($)
    $.ui.status(next.error && next.projects.length === 0 ? undefined : statusText(visible(next, names)))
    for (const line of changes(prev, visible(next, names))) $.ui.toast(line, { timeoutMs: 8000 })
    return next
  } finally {
    pending = null
  }
}

// One read at a time; a press during a timer's read shares it.
function refresh($: Engine): Promise<Snapshot> {
  pending ??= readAgain($)
  return pending
}

// The timer's read: `/shoemaker off` in any session stops it here too.
async function tick($: Engine) {
  const wasOff = isOff
  isOff = (await $.store.get('off')) === true
  if (isOff) {
    if (!wasOff) $.ui.status(undefined)
    return
  }
  await refresh($)
}

// Names a person typed, matched against the projects found.
const pick = (snap: Snapshot, words: string[]) => {
  const known = [...new Set(snap.projects.map(p => p.project))]
  const unknown = words.filter(w => !known.includes(w))
  return { known, unknown }
}

const described = (snap: Snapshot, names: readonly string[] | null) => {
  const hidden = snap.projects.filter(p => !isShown(p, names)).map(p => p.project)
  const line = summary(visible(snap, names)) || 'no project shown'
  return hidden.length === 0 ? line : `${line} (hidden: ${hidden.join(', ')})`
}

// A pane's Hide or Show press: the selection gains or loses one project.
async function toggle($: Engine, name: string, show: boolean) {
  const snap = await read($, snapshot)
  const known = snap ? [...new Set(snap.projects.map(p => p.project))] : []
  const current = (await loadShown($)) ?? known
  await saveShown($, show ? [...new Set([...current, name])] : current.filter(n => n !== name))
}

async function openUnasked($: Engine, autoOpen: string) {
  const snap = await refresh($)
  if (autoOpen === 'never' || snap.projects.length === 0) return
  if (await read($, isDismissed)) return
  const here = snap.projects.some(p =>
    [p.repo, p.umbrella, p.state].some(root => within(cwd, root)),
  )
  if (autoOpen === 'always' || here) await $.ui.open({ id: PANE, title: TITLE })
}

// ── the module ───────────────────────────────────────────────────────────

export const register: Register = (on, options) => {
  const autoOpen = String(options.autoOpen ?? 'project')
  const pollMs = Math.max(10, Number(options.pollSeconds ?? 60)) * 1000

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    cwd = started.cwd ?? e.cwd
    if (!e.isInteractive) return started

    await $.command.register({
      name: 'shoemaker',
      description: 'Show the status of your Shoemaker projects in a pane (show, hide, on, off, close)',
      argumentHint: '[show <project>…|hide <project>…|all|on|off|close]',
    })
    isOff = (await $.store.get('off')) === true
    $.clock.every(pollMs, () => void tick($))
    if (isOff) return started

    const kept = await read($, snapshot)
    if (kept) $.ui.status(statusText(visible(kept, await loadShown($))))
    void openUnasked($, autoOpen)

    return started
  })

  on('command.run', { command: 'shoemaker' }, async ($, e) => {
    // The first word is the verb; every word after show or hide is a project's
    // name, whatever it spells ("all", "off"), so no project is unreachable.
    const [verb = '', ...words] = e.args.trim().split(/[\s,]+/).filter(Boolean)
    const arg = verb
    if (verb === 'all') {
      const snap = await refresh($)
      await saveShown($, null)
      return { text: `Showing every Shoemaker project, in this and later sessions. ${described(snap, null)}` }
    }
    if (verb === 'show' || verb === 'hide') {
      const snap = await refresh($)
      if (words.length === 0) {
        return { text: `Name a project: /shoemaker ${verb} <project>…${verb === 'show' ? ', or /shoemaker all for every one' : ''}. Found: ${pick(snap, []).known.join(', ') || 'none'}.` }
      }
      const { known, unknown } = pick(snap, words)
      if (unknown.length > 0) {
        const hint = unknown.includes('all') ? ' To show every project, use /shoemaker all.' : ''
        return { text: `No Shoemaker project named ${unknown.join(', ')}. Found: ${known.join(', ') || 'none'}.${hint}` }
      }
      const current = (await loadShown($)) ?? known
      const names =
        verb === 'show' ? [...new Set(words)] : current.filter(n => !words.includes(n))
      await saveShown($, names)
      return { text: `Shoemaker selection saved for this and later sessions. ${described(snap, names)}` }
    }
    if (arg === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'Closed the Shoemaker pane.' }
    }
    if (arg === 'off') {
      isOff = true
      await $.store.set('off', true)
      $.ui.status(undefined)
      await $.ui.close({ id: PANE })
      return { text: 'Shoemaker status is off: no status line, refreshes or toasts, in this and later sessions. /shoemaker on turns it back on.' }
    }
    if (arg === 'on') {
      isOff = false
      await $.store.delete('off')
      const snap = await refresh($)
      return { text: `Shoemaker status is on. ${described(snap, await loadShown($))}` }
    }
    if (arg !== '') {
      return { text: `Unknown argument "${arg}". Use /shoemaker, /shoemaker show <project>…, /shoemaker hide <project>…, /shoemaker all, /shoemaker on, /shoemaker off or /shoemaker close.` }
    }
    await update($, isDismissed, () => false)
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    const snap = await refresh($)
    const text =
      snap.projects.length === 0
        ? 'Shoemaker: no projects found (no installed shoemaker units, and no state directory here or above).'
        : `Shoemaker — ${described(snap, await loadShown($))}`
    const notes = [
      opened.isPlaced ? '' : '(The pane waits for a wider terminal.)',
      isOff ? '(The status line is off; /shoemaker on turns it back on.)' : '',
    ].filter(Boolean)
    return { text: [text, ...notes].join('\n') }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await update($, isDismissed, () => true)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const names = await read($, shown)

    const refreshButton = (
      <Button key="refresh" label="Refresh" hotkey="r" onPress={() => void refresh($)} />
    )
    if (!snap) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Reading Shoemaker's status…</Text>
        </Box>
      )
    }
    if (snap.projects.length === 0) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text>No Shoemaker projects found.</Text>
          <Text dimColor>
            Looked for installed round units (shoemaker install) and a state directory at or above {cwd}.
          </Text>
          {snap.error ? <Text color="error">{snap.error}</Text> : null}
          <Box>{refreshButton}</Box>
        </Box>
      )
    }

    const row = (label: string, body: JSX.Element | string, key?: string) => (
      <Box key={key}>
        <Box width={10} flexShrink={0}>
          <Text dimColor>{label}</Text>
        </Box>
        {typeof body === 'string' ? <Text wrap="truncate-end">{body}</Text> : body}
      </Box>
    )
    const items = (p: Project, status: Item['status'], heading: string, color?: 'warning' | 'error') => {
      const list = p.items.filter(i => i.status === status)
      if (list.length === 0) return null
      return (
        <Box flexDirection="column">
          <Text bold color={color}>{heading}</Text>
          {list.map(i => (
            <Box>
              <Text wrap="truncate-end">
                {'  '}#{i.id} {i.title}
                {status === 'in_progress' && i.attempts ? <Text dimColor> · attempt {i.attempts}</Text> : ''}
                {status === 'failed' && i.status_note ? <Text dimColor> — {i.status_note}</Text> : ''}
              </Text>
              {status === 'review' && i.pr_url ? <Text> </Text> : null}
              {status === 'review' && i.pr_url ? <Link href={i.pr_url} label="PR" /> : null}
            </Box>
          ))}
        </Box>
      )
    }

    const project = (p: Project) => {
      const s = p.stats
      const d = p.direction
      const running = isRunning(p)
      const model = [d.model || 'default model', d.effort].filter(Boolean).join(' ')
      const short = (line: string) => line.split(`${p.state}/`).join('')
      return (
        <Box flexDirection="column" key={p.state}>
          <Box gap={1}>
            <Text bold>{p.project}</Text>
            <Box flexGrow={1}>
              <Text dimColor wrap="truncate-end">
                {d.mode || '?'} · {model}
                {d.enabled === 'false' ? ' · paused' : ''}
              </Text>
            </Box>
            {snap.projects.length > 1 ? (
              <Button key={`hide:${p.state}`} label="Hide" onPress={() => void toggle($, p.project, false)} />
            ) : null}
          </Box>
          {row(
            'round',
            <Text color={running ? 'success' : undefined} wrap="truncate-end">
              {roundPhrase(p, snap)}
              {running && p.latest ? ` · ${p.latest}` : ''}
            </Text>,
          )}
          {s === null
            ? null
            : row(
              'queue',
              <Text wrap="truncate-end">
                <Text color={s.proposed ? 'warning' : undefined}>{s.proposed} to review</Text>
                {' · '}
                {s.approved} approved ({s.ready} ready)
                {s.in_progress ? ` · ${s.in_progress} building` : ''}
                {s.review ? <Text color="warning"> · {s.review} to merge</Text> : ''}
                {s.failed ? <Text color="error"> · {s.failed} failed</Text> : ''}
                {` · ${s.shipped} shipped`}
              </Text>,
            )}
          {row(
            'agents',
            [
              `max ${d.maxBuilds || '?'} builds`,
              p.autoApproval === null ? '' : `auto approval ${p.autoApproval ? 'on' : 'off'}`,
              `gate ${p.gate || '?'}`,
            ]
              .filter(Boolean)
              .join(' · '),
          )}
          {p.dashboardUrl === ''
            ? null
            : row(
              'dashboard',
              <Box>
                <Link href={p.dashboardUrl} />
                <Text dimColor>
                  {p.dashboard ? ` ${p.dashboard.ActiveState}` : ' not installed'}
                </Text>
              </Box>,
            )}
          {row(
            'checkout',
            p.rev
              ? `${p.rev}${p.behind > 0 ? ` (${p.behind} behind upstream: shoemaker update)` : ''}`
              : p.home || 'not found',
          )}
          {items(p, 'in_progress', 'Building')}
          {items(p, 'review', 'Waiting for your merge', 'warning')}
          {items(p, 'failed', 'Failed', 'error')}
          {p.rounds.length === 0 ? null : (
            <Box flexDirection="column">
              <Text bold>Recent rounds</Text>
              {[...p.rounds].reverse().map(r => (
                <Text wrap="truncate-end">
                  {'  '}{r.id}  <Text dimColor>{short(r.last)}</Text>
                </Text>
              ))}
              {p.idle > 0 ? <Text dimColor>{'  '}+ {p.idle} idle round(s)</Text> : null}
            </Box>
          )}
          {p.tail.length === 0 ? null : (
            <Box flexDirection="column">
              <Text bold>Latest log{running ? '' : ` (${p.latest})`}</Text>
              {p.tail.map(line => (
                <Text dimColor wrap="truncate-end">
                  {'  '}{short(line)}
                </Text>
              ))}
            </Box>
          )}
        </Box>
      )
    }

    const hidden = snap.projects.filter(p => !isShown(p, names))
    return (
      <Box flexDirection="column" gap={1}>
        {snap.projects.filter(p => isShown(p, names)).map(project)}
        {hidden.length === 0 ? null : (
          <Box flexDirection="column">
            <Text dimColor>Hidden from the status line and toasts</Text>
            {hidden.map(p => (
              <Box gap={1}>
                <Text>{'  '}{p.project}</Text>
                <Box flexGrow={1}>
                  <Text dimColor wrap="truncate-end">{roundPhrase(p, snap)}</Text>
                </Box>
                <Button key={`show:${p.state}`} label="Show" onPress={() => void toggle($, p.project, true)} />
              </Box>
            ))}
          </Box>
        )}
        <Box gap={1}>
          {refreshButton}
          <Text dimColor>
            updated {when(snap.at / 1000, snap)}:{pad(new Date(snap.at).getUTCSeconds())}
          </Text>
        </Box>
        {snap.error ? <Text color="error">Last refresh failed: {snap.error}</Text> : null}
      </Box>
    )
  })
}
