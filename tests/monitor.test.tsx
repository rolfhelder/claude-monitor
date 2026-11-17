import { expect, test } from 'claude-code/testing'
import { formatStatus, isStale, pythonOf, renderPlist, settingsFrom } from '../hooks/lib'
import type { Sample } from '../hooks/lib'

const NOW = 1_800_000_000_000
const sample = (ageS: number): Sample => ({
  ts: NOW / 1000 - ageS,
  sys: { total_gb: 48, used_gb: 30.2, cached_gb: 9.1, swap_used_gb: 0.93, pressure: 'normal', cores: 18, cpu_used: 1.624 },
})

test('status line formats RAM, cache, swap and busy CPUs', async () => {
  expect(formatStatus(true, sample(2), NOW, 5)).toBe(
    'ON · 30/48 GB RAM · 9 GB cache · 1 GB swap · 1.62/18 CPU · RAM normal · CPU ok',
  )
  expect(formatStatus(false, sample(2), NOW, 5)).toBe('OFF')
  expect(formatStatus(true, null, NOW, 5)).toBe('ON · waiting for the first sample')
})

test('CPU state comes from the busy CPUs shown', async () => {
  const s = sample(1)
  s.sys.cpu_used = 12
  expect(formatStatus(true, s, NOW, 5)).toContain('12.00/18 CPU · RAM normal · CPU busy')
})

test('a sample older than three intervals is stale', async () => {
  expect(isStale(sample(14), NOW, 5)).toBe(false)
  expect(isStale(sample(16), NOW, 5)).toBe(true)
  expect(formatStatus(true, sample(300), NOW, 5)).toBe('ON · stale · last sample 5 min ago')
})

test('settings are clamped and defaulted', async () => {
  expect(settingsFrom({})).toEqual({ sampleSeconds: 5, placement: 'above-prompt', detailedLogs: false, hungApps: false })
  expect(settingsFrom({ sampleSeconds: 1, placement: 'status-line' }).sampleSeconds).toBe(2)
  expect(settingsFrom({ sampleSeconds: 9999 }).sampleSeconds).toBe(300)
})

test('the plist renders escaped values and round-trips the python path', async () => {
  const tpl = '<key>ProgramArguments</key>\n<array>\n<string>{{PYTHON}}</string>\n<string>{{SAMPLER}}</string>\n{{ARGS}}</array>{{INTERVAL}}{{LOG_DIR}}{{LABEL}}'
  const out = renderPlist(tpl, {
    python: '/opt/py&3',
    sampler: '/x/sampler.py',
    logDir: '/x/logs',
    settings: settingsFrom({ sampleSeconds: 7, detailedLogs: true }),
  })
  expect(out).toContain('/opt/py&amp;3')
  expect(out).toContain('<string>--detailed</string>')
  expect(out).not.toContain('--hung-apps')
  expect(out).toContain('7/x/logs')
  expect(pythonOf(out)).toBe('/opt/py&3')
})

test('replacement patterns in paths stay literal', async () => {
  const out = renderPlist('{{PYTHON}}|{{SAMPLER}}', { python: "/a/$&/$'", sampler: '/b/$`', logDir: '/l', settings: settingsFrom({}) })
  expect(out).toBe("/a/$&amp;/$'|/b/$`")
})

type Env = { platform?: 'macos' | 'linux'; loaded?: boolean; latest?: string; noPython?: boolean }

function engine(on: any, env: Env = {}) {
  const runs: string[][] = []
  const files = new Map<string, string>()
  let loaded = env.loaded ?? false
  on('session.info', () => ({ value: { platform: env.platform ?? 'macos' } }))
  on('env.get', () => ({ value: '/home/u' }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'monitor' } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('fs.read', (_: unknown, e: any) => {
    const p = String(e.path ?? e)
    if (p.endsWith('agent.plist.template')) return { value: '<key>ProgramArguments</key><array><string>{{PYTHON}}</string>{{ARGS}}</array>' }
    if (p.endsWith('sampler/sampler.py')) return { value: 'code' }
    if (p.endsWith('latest.json') && env.latest) return { value: env.latest }
    if (files.has(p)) return { value: files.get(p) }
    return { deny: 'ENOENT' }
  })
  on('fs.write', (_: unknown, e: any) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', (_: unknown, e: any) => ({ value: files.has(String(e.path ?? e)) }))
  on('fs.stat', () => ({ value: { kind: 'dir', size: 0, mtimeMs: NOW, isLink: false } }))
  on('process.run', (_: unknown, e: any) => {
    const argv = [...e.argv] as string[]
    runs.push(argv)
    let code = 0
    let stdout = ''
    if (argv[0] === '/usr/bin/id') stdout = '501\n'
    if (env.noPython && (argv[1] === '-c' || argv[0] === '/usr/bin/xcode-select')) code = 1
    if (argv[0] === '/bin/sh') stdout = '/opt/homebrew/bin/python3\n'
    if (argv[0] === '/bin/launchctl' && argv[1] === 'print') code = loaded ? 0 : 113
    if (argv[0] === '/bin/launchctl' && argv[1] === 'bootstrap') loaded = true
    if (argv[0] === '/bin/launchctl' && argv[1] === 'bootout') loaded = false
    return { value: { exitCode: code, stdout, stderr: '' } }
  })
  return { runs, files }
}

const launchctl = (runs: string[][], verb: string) => runs.filter(r => r[0] === '/bin/launchctl' && r[1] === verb)

test('/monitor on installs and bootstraps the agent', async ($, on) => {
  const { runs, files } = engine(on)
  const r: any = await $.command.run({ command: 'monitor', args: 'on' } as any)
  expect(JSON.stringify(r)).toContain('Monitor ON: sampling every 5 s')
  expect(launchctl(runs, 'bootstrap')).toHaveLength(1)
  expect(runs.some(a => a[0] === '/usr/bin/python3' && a[1] === '-c')).toBe(true)
  expect([...files.keys()].some(k => k.endsWith('io.github.rolfhelder.claude-monitor.plist'))).toBe(true)
})

test('/monitor off boots the agent out and removes the plist', async ($, on) => {
  const { runs } = engine(on, { loaded: true })
  const r: any = await $.command.run({ command: 'monitor', args: 'off' } as any)
  expect(JSON.stringify(r)).toContain('Monitor OFF')
  expect(launchctl(runs, 'bootout')).toHaveLength(1)
  expect(runs.some(a => a[0] === '/bin/rm')).toBe(true)
})

test('report rejects a bad duration without running anything', async ($, on) => {
  const { runs } = engine(on)
  const r: any = await $.command.run({ command: 'monitor', args: 'report 2x' } as any)
  expect(JSON.stringify(r)).toContain('report takes one duration')
  expect(runs.some(a => a.includes('report'))).toBe(false)
})

test('on another OS the command explains and does nothing', async ($, on) => {
  const { runs } = engine(on, { platform: 'linux' })
  const r: any = await $.command.run({ command: 'monitor', args: 'on' } as any)
  expect(JSON.stringify(r)).toContain('macOS only')
  expect(runs).toHaveLength(0)
})

for (const placement of ['above-prompt', 'status-line'] as const) {
  test(`placement ${placement}`, { options: { placement } }, async ($, on) => {
    engine(on, { loaded: true, latest: JSON.stringify(sample(1)) })
    const statuses: unknown[] = []
    on('ui.status', (_: unknown, e: any) => {
      statuses.push(e.text ?? e)
      return { value: undefined }
    })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'monitor', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } } as any)
    const row = await ui.find({ type: 'Text', text: /30\/48 GB RAM/ })
    if (placement === 'above-prompt') expect(row).toBeDefined()
    else {
      expect(row).toBeUndefined()
      expect(JSON.stringify(statuses)).toContain('30/48 GB RAM')
    }
    await ui.unmount()
  })
}

test('a starting session never installs an agent that is off', async ($, on) => {
  const { runs } = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(launchctl(runs, 'bootstrap')).toHaveLength(0)
})

test('/monitor on refuses when no python3 runs', async ($, on) => {
  const { runs } = engine(on, { noPython: true })
  const r: any = await $.command.run({ command: 'monitor', args: 'on' } as any)
  expect(JSON.stringify(r)).toContain('No working python3')
  expect(launchctl(runs, 'bootstrap')).toHaveLength(0)
})

test('/monitor view toggles the placement option; bare /monitor toggles the recorder', async ($, on) => {
  engine(on)
  const sets: any[] = []
  on('config.set', (_: unknown, e: any) => { sets.push(e); return { value: e.value } })
  const r: any = await $.command.run({ command: 'monitor', args: 'view' } as any)
  expect(sets.map(s => [s.key, s.value])).toEqual([['monitor.placement', 'status-line']])
  expect(JSON.stringify(r)).toContain('in the status line')
  const bare: any = await $.command.run({ command: 'monitor', args: '' } as any)
  expect(JSON.stringify(bare)).toContain('Monitor ON')
  expect(sets).toHaveLength(1)
})

test('an unknown /monitor argument is handed to Claude', async ($, on) => {
  engine(on)
  const prompts: string[] = []
  const timers: any[] = []
  on('clock.after', (_: unknown, e: any) => { timers.push(e); return { value: undefined } })
  on('prompt.submit', (_: unknown, e: any) => { prompts.push(e.text); return { text: e.text } })
  const r: any = await $.command.run({ command: 'monitor', args: 'put in statusline' } as any)
  expect(JSON.stringify(r)).toContain('asked Claude')
  expect(timers).toHaveLength(1)
  expect(prompts).toHaveLength(0)
})

test('bare /monitor turns a running recorder off', async ($, on) => {
  const { runs } = engine(on, { loaded: true })
  const r: any = await $.command.run({ command: 'monitor', args: '' } as any)
  expect(JSON.stringify(r)).toContain('Monitor OFF')
  expect(launchctl(runs, 'bootout')).toHaveLength(1)
})
