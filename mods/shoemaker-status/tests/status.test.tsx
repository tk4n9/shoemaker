import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Project } from '../types'

// A fictional project; nothing here is read from a real machine.
const NOW = Date.UTC(2026, 9, 28, 13, 40) // 22:40 at +0900
const inkwell = (over: Partial<Project> = {}): Project => ({
  state: '/work/inkwell/.shoemaker',
  home: '/opt/shoemaker',
  rev: 'abc1234',
  behind: 2,
  project: 'inkwell',
  repo: '/work/inkwell',
  umbrella: '',
  host: 'github',
  branch: 'main',
  gate: 'ci',
  dashboardUrl: 'http://127.0.0.1:6531',
  unit: 'shoemaker-inkwell',
  direction: { enabled: 'true', mode: 'review', model: 'opus', effort: 'high', maxBuilds: '2' },
  timer: { ActiveState: 'active', NextElapseUSecRealtime: NOW / 1000 + 50 * 60, LastTriggerUSec: NOW / 1000 - 600 },
  round: { ActiveState: 'activating', SubState: 'start', ExecMainStartTimestamp: NOW / 1000 - 600 },
  dashboard: { ActiveState: 'active' },
  stats: { proposed: 3, approved: 4, in_progress: 1, review: 0, shipped: 9, failed: 0, archived: 0, ready: 3, total: 17 },
  items: [{ id: 7, title: 'Add a word count', status: 'in_progress', pr_url: null, attempts: 1, status_note: null, last_run: 'r1' }],
  autoApproval: false,
  rounds: [{ id: '2026-10-28-2230', last: '#7: claude started' }],
  latest: '2026-10-28-2230',
  tail: ['#7: claude started'],
  idle: 0,
  ...over,
})

const finished = inkwell({
  round: { ActiveState: 'inactive', SubState: 'dead', ExecMainStartTimestamp: NOW / 1000 - 600 },
  stats: { proposed: 3, approved: 3, in_progress: 0, review: 1, shipped: 9, failed: 0, archived: 0, ready: 3, total: 17 },
  items: [{ id: 7, title: 'Add a word count', status: 'review', pr_url: 'https://example.com/pr/12', attempts: 1, status_note: null, last_run: 'r1' }],
})

// Stands for the host: the status script answers each read with the next project list.
const host = (on: On, reads: Project[][], store: Record<string, unknown> = {}) => {
  const seen = { toasts: [] as string[], status: [] as (string | undefined)[], opened: [] as string[], reads: 0 }
  let n = 0
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, store)
  on('process.run', () => {
    seen.reads += 1
    const projects = reads[Math.min(n++, reads.length - 1)]
    const stdout = JSON.stringify({ offset: '+0900', projects })
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', () => ({ value: { command: 'shoemaker' } }))
  on('ui.open', (_, e) => {
    seen.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    seen.status.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return Object.assign(seen, { clock })
}

// The person typing /shoemaker in the fullscreen terminal.
const RUN = {
  command: 'shoemaker',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
} as const

const PANE = {
  plugin: 'shoemaker-status',
  component: 'Pane',
  requestId: 'shoemaker',
  props: {
    title: 'Shoemaker',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('/shoemaker opens the pane, and the status line and pane show the project', async ($, on) => {
  const seen = host(on, [[inkwell()]])
  await $.session.start({ cwd: '/elsewhere', surface: 'terminal', isInteractive: true })

  const ran = await $.command.run(RUN)
  expect(ran.text).toContain('inkwell: round running 10m · 1 building · 3 to review · 3 ready')
  expect(seen.opened).toContain('shoemaker')
  expect(seen.status.at(-1)).toBe('👞 inkwell: round running 10m · 1 building · 3 to review · 3 ready')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^inkwell$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /3 to review/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /#7 Add a word count/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2 behind upstream/ })).toBeDefined()
    await ui.press({ key: 'refresh' })
    await ui.unmount()
  }
})

test('a finished round is told once, with what changed', async ($, on) => {
  const seen = host(on, [[inkwell()], [finished], [finished]])
  await $.session.start({ cwd: '/elsewhere', surface: 'terminal', isInteractive: true })
  await $.command.run(RUN)
  await $.command.run(RUN)
  await $.command.run(RUN)

  expect(seen.toasts).toEqual(['👞 inkwell: round 2026-10-28-2230 finished: +1 to merge'])
  expect(seen.status.at(-1)).toBe('👞 inkwell: next 23:30 · 3 to review · 1 to merge · 3 ready')
})

test('the pane opens by itself only inside a project', async ($, on) => {
  const seen = host(on, [[finished]])
  await $.session.start({ cwd: '/work/inkwell/src', surface: 'terminal', isInteractive: true })
  await seen.clock.settle()
  expect(seen.opened).toEqual(['shoemaker'])
})

test('no pane unasked outside a project', async ($, on) => {
  const seen = host(on, [[finished]])
  await $.session.start({ cwd: '/work/other', surface: 'terminal', isInteractive: true })
  await seen.clock.settle()
  expect(seen.opened).toEqual([])
  expect(seen.status.at(-1)).toBe('👞 inkwell: next 23:30 · 3 to review · 1 to merge · 3 ready')
})

test('a snapshot an earlier version stored is declined', async ($, on) => {
  on('state.get', () => ({ value: { value: { projects: 'old' }, version: 1 } }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe("Reading Shoemaker's status…")
  await ui.unmount()
})

test('several projects share the status line, each its own entry', async ($, on) => {
  const quill = inkwell({ state: '/work/quill/.shoemaker', project: 'quill', repo: '/work/quill' })
  const seen = host(on, [[finished, { ...quill, stats: { ...quill.stats!, proposed: 0, review: 0 } }]])
  await $.session.start({ cwd: '/elsewhere', surface: 'terminal', isInteractive: true })
  await seen.clock.settle()
  expect(seen.status.at(-1)).toBe(
    '👞 inkwell: next 23:30 · 3 to review · 1 to merge · 3 ready  │  quill: round running 10m · 1 building · 3 ready',
  )

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^inkwell$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^quill$/ })).toBeDefined()
  await ui.unmount()
})

test('/shoemaker off clears the line and stops reading, until /shoemaker on', async ($, on) => {
  const seen = host(on, [[inkwell()], [finished]])
  await $.session.start({ cwd: '/elsewhere', surface: 'terminal', isInteractive: true })
  await seen.clock.settle()

  const off = await $.command.run({ ...RUN, args: 'off' })
  expect(off.text).toContain('is off')
  expect(seen.status.at(-1)).toBeUndefined()
  const before = seen.reads
  await seen.clock.advance(5 * 60_000)
  expect(seen.reads).toBe(before)
  expect(seen.toasts).toEqual([])

  const back = await $.command.run({ ...RUN, args: 'on' })
  expect(back.text).toContain('is on')
  expect(seen.status.at(-1)).toBe('👞 inkwell: next 23:30 · 3 to review · 1 to merge · 3 ready')
})

test('a session started after /shoemaker off stays off', async ($, on) => {
  const seen = host(on, [[inkwell()]], { off: true })
  await $.session.start({ cwd: '/work/inkwell', surface: 'terminal', isInteractive: true })
  await seen.clock.advance(5 * 60_000)
  expect(seen.status).toEqual([])
  expect(seen.opened).toEqual([])
})

const quill = inkwell({
  state: '/work/quill/.shoemaker',
  project: 'quill',
  repo: '/work/quill',
  round: { ActiveState: 'inactive', SubState: 'dead' },
  stats: { proposed: 0, approved: 0, in_progress: 0, review: 0, shipped: 4, failed: 0, archived: 0, ready: 0, total: 4 },
  items: [],
})
const both = [finished, quill]

test('/shoemaker show and hide pick the projects shown, and /shoemaker all brings them back', async ($, on) => {
  const seen = host(on, [both])
  await $.session.start({ cwd: '/elsewhere', surface: 'terminal', isInteractive: true })
  await seen.clock.settle()

  const shown = await $.command.run({ ...RUN, args: 'show quill' })
  expect(shown.text).toContain('quill: next 23:30 (hidden: inkwell)')
  expect(seen.status.at(-1)).toBe('👞 quill: next 23:30')

  const refused = await $.command.run({ ...RUN, args: 'show nib' })
  expect(refused.text).toBe('No Shoemaker project named nib. Found: inkwell, quill.')
  expect(seen.status.at(-1)).toBe('👞 quill: next 23:30')

  await $.command.run({ ...RUN, args: 'all' })
  await $.command.run({ ...RUN, args: 'hide quill' })
  expect(seen.status.at(-1)).toBe('👞 inkwell: next 23:30 · 3 to review · 1 to merge · 3 ready')

  await $.command.run({ ...RUN, args: 'all' })
  expect(seen.status.at(-1)).toBe(
    '👞 inkwell: next 23:30 · 3 to review · 1 to merge · 3 ready  │  quill: next 23:30',
  )
})

test('a selection saved earlier holds in a new session', async ($, on) => {
  const seen = host(on, [both], { shown: ['quill'] })
  await $.session.start({ cwd: '/elsewhere', surface: 'terminal', isInteractive: true })
  await seen.clock.settle()
  expect(seen.status.at(-1)).toBe('👞 quill: next 23:30')
})

test('a hidden project raises no toast', async ($, on) => {
  const seen = host(on, [[inkwell(), quill], both], { shown: ['quill'] })
  await $.session.start({ cwd: '/elsewhere', surface: 'terminal', isInteractive: true })
  await seen.clock.settle()
  await $.command.run(RUN)
  expect(seen.toasts).toEqual([])
})

test('the pane hides and shows a project with its buttons, on every surface', async ($, on) => {
  const seen = host(on, [both])
  await $.session.start({ cwd: '/elsewhere', surface: 'terminal', isInteractive: true })
  await seen.clock.settle()
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    await ui.press({ key: 'hide:/work/inkwell/.shoemaker' })
    expect(seen.status.at(-1)).toBe('👞 quill: next 23:30')
    expect(await ui.find({ type: 'Text', text: /Hidden from the status line/ })).toBeDefined()

    await ui.press({ key: 'show:/work/inkwell/.shoemaker' })
    expect(seen.status.at(-1)).toBe(
      '👞 inkwell: next 23:30 · 3 to review · 1 to merge · 3 ready  │  quill: next 23:30',
    )
    expect(await ui.find({ type: 'Text', text: /Hidden from the status line/ })).toBeUndefined()
    await ui.unmount()
    await $.command.run({ ...RUN, args: 'all' })
  }
})

test('a project named all is a project like any other', async ($, on) => {
  const named = (project: string) =>
    inkwell({ state: `/work/${project}/.shoemaker`, project, repo: `/work/${project}` })
  const seen = host(on, [[named('all'), named('off')]])
  await $.session.start({ cwd: '/elsewhere', surface: 'terminal', isInteractive: true })
  await seen.clock.settle()

  await $.command.run({ ...RUN, args: 'show all' })
  expect(seen.status.at(-1)).toBe('👞 all: round running 10m · 1 building · 3 to review · 3 ready')

  await $.command.run({ ...RUN, args: 'show off' })
  expect(seen.status.at(-1)).toBe('👞 off: round running 10m · 1 building · 3 to review · 3 ready')

  await $.command.run({ ...RUN, args: 'all' })
  expect(seen.status.at(-1)).toContain('all: round running')
  expect(seen.status.at(-1)).toContain('off: round running')
})

test('show all, with no project named all, points to /shoemaker all', async ($, on) => {
  const seen = host(on, [both], { shown: ['quill'] })
  await $.session.start({ cwd: '/elsewhere', surface: 'terminal', isInteractive: true })
  await seen.clock.settle()
  const ran = await $.command.run({ ...RUN, args: 'show all' })
  expect(ran.text).toBe('No Shoemaker project named all. Found: inkwell, quill. To show every project, use /shoemaker all.')
  expect(seen.status.at(-1)).toBe('👞 quill: next 23:30')
})
