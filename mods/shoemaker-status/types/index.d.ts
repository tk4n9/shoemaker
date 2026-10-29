// What scripts/collect.sh prints, one entry per Shoemaker project.
export type UnitProps = Record<string, string | number>

export type Item = {
  id: number
  title: string
  status: 'in_progress' | 'review' | 'failed'
  pr_url: string | null
  attempts: number | null
  status_note: string | null
  last_run: string | null
}

export type Stats = {
  proposed: number
  approved: number
  in_progress: number
  review: number
  shipped: number
  failed: number
  archived: number
  ready: number
  total: number
}

export type Project = {
  state: string
  home: string
  rev: string
  behind: number
  project: string
  repo: string
  umbrella: string
  host: string
  branch: string
  gate: string
  dashboardUrl: string
  unit: string
  direction: {
    enabled: string
    mode: string
    model: string
    effort: string
    maxBuilds: string
  }
  timer: UnitProps | null
  round: UnitProps | null
  dashboard: UnitProps | null
  stats: Stats | null
  items: Item[]
  autoApproval: boolean | null
  rounds: { id: string; last: string }[]
  latest: string
  tail: string[]
  idle: number
}

export type Snapshot = {
  // When it was collected, in ms since the epoch, and the host's UTC offset in minutes.
  at: number
  offsetMinutes: number
  projects: Project[]
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'shoemaker-status': {
      snapshot: Shaped<Snapshot | null>
      isDismissed: boolean
      // The projects shown, by name, as kept in $.store; null shows every one.
      shown: string[] | null
    }
  }
}
