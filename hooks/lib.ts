export const LABEL = 'io.github.rolfhelder.claude-monitor'

export type Placement = 'above-prompt' | 'status-line'

export type Settings = {
  sampleSeconds: number
  placement: Placement
  detailedLogs: boolean
  hungApps: boolean
}

export type Sample = {
  ts: number
  sys: {
    total_gb: number | null
    used_gb: number
    cached_gb: number
    swap_used_gb: number | null
    pressure: string
    cores: number
    cpu_used: number | null
  }
}

export function settingsFrom(options: Record<string, unknown>): Settings {
  const n = Math.round(Number(options.sampleSeconds ?? 5))
  return {
    sampleSeconds: Number.isFinite(n) ? Math.min(300, Math.max(2, n)) : 5,
    placement: options.placement === 'status-line' ? 'status-line' : 'above-prompt',
    detailedLogs: options.detailedLogs === true,
    hungApps: options.hungApps === true,
  }
}

export function paths(home: string) {
  return {
    logDir: `${home}/Library/Logs/claude-monitor`,
    supportDir: `${home}/Library/Application Support/claude-monitor`,
    sampler: `${home}/Library/Application Support/claude-monitor/sampler.py`,
    lock: `${home}/Library/Application Support/claude-monitor/launchd.lock`,
    seen: `${home}/Library/Application Support/claude-monitor/last-seen`,
    plist: `${home}/Library/LaunchAgents/${LABEL}.plist`,
  }
}

const xml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function renderPlist(template: string, v: { python: string; sampler: string; logDir: string; settings: Settings }): string {
  const args = [v.settings.detailedLogs && '--detailed', v.settings.hungApps && '--hung-apps']
    .filter((a): a is string => !!a)
    .map(a => `\t\t<string>${a}</string>\n`)
    .join('')
  return template
    .replace('{{LABEL}}', () => LABEL)
    .replace('{{PYTHON}}', () => xml(v.python))
    .replace('{{SAMPLER}}', () => xml(v.sampler))
    .replace('{{ARGS}}', () => args)
    .replace('{{INTERVAL}}', () => String(v.settings.sampleSeconds))
    .replace(/\{\{LOG_DIR\}\}/g, () => xml(v.logDir))
}

/** The python path an installed plist already uses, so a settings check needs no lookup. */
export function pythonOf(plist: string): string | null {
  const m = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/.exec(plist)
  return m?.[1]?.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&') ?? null
}

export const SINCE = /^\d{1,4}[mhd]$/

export function cpuState(busy: number, cores: number): string {
  const r = busy / Math.max(1, cores)
  return r < 0.5 ? 'ok' : r < 0.9 ? 'busy' : 'saturated'
}

export function age(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 120) return `${s} s`
  if (s < 7200) return `${Math.round(s / 60)} min`
  return `${Math.round(s / 3600)} h`
}

export function isStale(sample: Sample, nowMs: number, sampleSeconds: number): boolean {
  return nowMs / 1000 - sample.ts > 3 * sampleSeconds
}

export function formatStatus(isOn: boolean, sample: Sample | null, nowMs: number, sampleSeconds: number): string {
  if (!isOn) return 'OFF'
  if (!sample) return 'ON · waiting for the first sample'
  if (isStale(sample, nowMs, sampleSeconds)) return `ON · stale · last sample ${age(nowMs / 1000 - sample.ts)} ago`
  const s = sample.sys
  const gb = (x: number | null) => (x === null ? '?' : String(Math.round(x)))
  const cpu = s.cpu_used === null ? '?' : s.cpu_used.toFixed(2)
  const state = s.cpu_used === null ? '?' : cpuState(s.cpu_used, s.cores)
  return `ON · ${gb(s.used_gb)}/${gb(s.total_gb)} GB RAM · ${gb(s.cached_gb)} GB cache · ${gb(s.swap_used_gb)} GB swap · ${cpu}/${s.cores} CPU · RAM ${s.pressure} · CPU ${state}`
}
