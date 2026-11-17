import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import { LABEL, SINCE, formatStatus, paths, pythonOf, renderPlist, settingsFrom } from './lib'
import type { Sample, Settings } from './lib'

const line = atom({ plugin: 'monitor', key: 'line' } as const, null)

const AGENT_CHECK_MS = 60_000
const HELP = 'Usage: /monitor [on | off] | view | report [30m|2h|3d]   (view toggles status line / above the prompt)'

let settings: Settings = settingsFrom({})
let uid: string | null = null
let home: string | null = null
let macos: boolean | null = null
let agent: { isOn: boolean; at: number } | null = null

async function isMac($: EngineInterface): Promise<boolean> {
  if (macos === null) macos = (await $.session.info()).platform === 'macos'
  return macos
}

async function where($: EngineInterface) {
  if (home === null) home = (await $.env.get('HOME')) ?? ''
  return paths(home)
}

async function domain($: EngineInterface): Promise<string> {
  if (uid === null) uid = (await $.process.run(['/usr/bin/id', '-u'])).stdout.trim()
  return `gui/${uid}`
}

async function agentOn($: EngineInterface, force = false): Promise<boolean> {
  const now = await $.clock.now()
  if (!force && agent && now - agent.at < AGENT_CHECK_MS) return agent.isOn
  const r = await $.process.run(['/bin/launchctl', 'print', `${await domain($)}/${LABEL}`])
  agent = { isOn: r.exitCode === 0, at: now }
  return agent.isOn
}

async function readText($: EngineInterface, path: string): Promise<string | null> {
  try {
    return await $.fs.read(path)
  } catch {
    return null
  }
}

async function latest($: EngineInterface): Promise<Sample | null> {
  const text = await readText($, `${(await where($)).logDir}/latest.json`)
  try {
    return text ? (JSON.parse(text) as Sample) : null
  } catch {
    return null
  }
}

async function statusText($: EngineInterface, force = false): Promise<string> {
  const isOn = await agentOn($, force)
  return formatStatus(isOn, isOn ? await latest($) : null, await $.clock.now(), settings.sampleSeconds)
}

async function refresh($: EngineInterface, force = false): Promise<void> {
  try {
    const text = `monitor: ${await statusText($, force)}`
    if (text === (await read($, line))) return
    await update($, line, () => text)
    if (settings.placement === 'status-line') $.ui.status(text.replace(/^monitor: /, ''))
  } catch {}
}

/** /usr/bin/python3 when the developer tools are installed, else python3 on PATH; null when neither runs. */
async function python($: EngineInterface): Promise<string | null> {
  const candidates: string[] = []
  if ((await $.process.run(['/usr/bin/xcode-select', '-p'])).exitCode === 0) candidates.push('/usr/bin/python3')
  const r = await $.process.run(['/bin/sh', '-c', 'command -v python3'])
  const found = r.stdout.trim()
  if (r.exitCode === 0 && found.startsWith('/') && found !== '/usr/bin/python3') candidates.push(found)
  for (const py of candidates) {
    const ok = await $.process.run([py, '-c', 'pass']).catch(() => null)
    if (ok?.exitCode === 0) return py
  }
  return null
}

const NO_PYTHON = 'No working python3 found. Install the Xcode command line tools (xcode-select --install) or Python 3, then run /monitor on again.'


async function withLock<T>($: EngineInterface, fn: () => Promise<T>): Promise<T | null> {
  const p = await where($)
  await $.process.run(['/bin/mkdir', '-p', p.supportDir, p.logDir, `${home}/Library/LaunchAgents`])
  let got = (await $.process.run(['/bin/mkdir', p.lock])).exitCode === 0
  if (!got) {
    const st = await $.fs.stat(p.lock).catch(() => null)
    if (st && (await $.clock.now()) - st.mtimeMs > 60_000) {
      await $.process.run(['/bin/rmdir', p.lock])
      got = (await $.process.run(['/bin/mkdir', p.lock])).exitCode === 0
    }
  }
  if (!got) return null
  try {
    return await fn()
  } finally {
    await $.process.run(['/bin/rmdir', p.lock])
  }
}

/** Writes the sampler copy and plist when they differ from what is wanted; reloads the agent only then. */
async function install($: EngineInterface, py?: string, onlyIfInstalled = false): Promise<'unchanged' | 'installed' | 'busy' | 'off' | string> {
  const p = await where($)
  const template = await $.fs.read(`${$.plugin.root}/launchd/agent.plist.template`)
  const code = await $.fs.read(`${$.plugin.root}/sampler/sampler.py`)
  const current = await readText($, p.plist)
  const wanted = renderPlist(template, {
    python: py ?? (current && pythonOf(current)) ?? (await python($)) ?? '/usr/bin/python3',
    sampler: p.sampler,
    logDir: p.logDir,
    settings,
  })
  const loaded = await agentOn($, true)
  if (loaded && current === wanted && (await readText($, p.sampler)) === code) return 'unchanged'
  const result = await withLock($, async () => {
    if (onlyIfInstalled && !(await $.fs.exists(p.plist))) return 'off'
    await $.fs.write(p.sampler, code)
    await $.fs.write(p.plist, wanted)
    const target = await domain($)
    await $.process.run(['/bin/launchctl', 'bootout', `${target}/${LABEL}`])
    const r = await $.process.run(['/bin/launchctl', 'bootstrap', target, p.plist])
    return r.exitCode === 0 ? 'installed' : r.stderr.trim() || `launchctl exited ${r.exitCode}`
  })
  agent = null
  return result ?? 'busy'
}

async function uninstall($: EngineInterface): Promise<string | null> {
  const p = await where($)
  const result = await withLock($, async () => {
    await $.process.run(['/bin/launchctl', 'bootout', `${await domain($)}/${LABEL}`])
    await $.process.run(['/bin/rm', '-f', p.plist])
    return 'ok'
  })
  agent = null
  return result
}

/** Toggles where the line shows: status line <-> row above the prompt. The engine reloads the plugin with the new option. */
async function toggleView($: EngineInterface): Promise<string> {
  const value = settings.placement === 'status-line' ? 'above-prompt' : 'status-line'
  const { deny } = await $.config.set({ key: 'monitor.placement', value })
  if (!deny) { settings = { ...settings, placement: value }; $.ui.status(undefined) } // the outgoing instance still refreshes once after this command; only it can clear its own entry
  return deny ? `Could not change the view: ${deny}` : `Now shown ${value === 'status-line' ? 'in the status line' : 'above the prompt'}.`
}

/** Input the command doesn't know goes to Claude, with the command's help, to act on. A command can't start a turn itself, so the prompt goes out just after it returns. */
async function askClaude($: EngineInterface, args: string, help: string): Promise<string> {
  const text = `I ran \`/monitor ${args}\`, which the monitor plugin did not recognise. Its help: ${help} Work out what I meant and do it (for example run the matching /monitor subcommand for me by telling me which, or change its setting with \`claude plugin configure\`), or ask me if it is unclear.`
  $.clock.after(50, () => void $.prompt.submit({ text }).catch(() => {}))
  return `Not a /monitor subcommand; asked Claude what you meant.`
}

async function runCommand($: EngineInterface, args: string): Promise<string> {
  if (!(await isMac($))) return 'monitor runs on macOS only; nothing was changed.'
  const words = args.trim().split(/\s+/).filter(Boolean)
  // bare /monitor toggles the recorder
  const [cmd = (await agentOn($, true)) ? 'off' : 'on', arg, extra] = words
  const logs = '~/Library/Logs/claude-monitor/'
  if (cmd === 'on') {
    const py = await python($)
    if (!py) return NO_PYTHON
    const r = await install($, py)
    await $.fs.write((await where($)).seen, String(Math.round((await $.clock.now()) / 1000))).catch(() => {})
    if (r === 'unchanged') return 'Monitor already ON.'
    if (r === 'installed') return `Monitor ON: sampling every ${settings.sampleSeconds} s into ${logs}`
    if (r === 'busy') return 'Another session is changing the monitor right now; try again in a moment.'
    return `Could not start: ${r}`
  }
  if (cmd === 'off') {
    const wasOn = await agentOn($, true)
    const exists = await $.fs.exists((await where($)).plist)
    if (!wasOn && !exists) return 'Monitor already OFF.'
    const r = await uninstall($)
    return r ? `Monitor OFF. Logs are kept in ${logs}` : 'Another session is changing the monitor right now; try again in a moment.'
  }
  if (cmd === 'report') {
    const since = arg ?? '2h'
    if (!SINCE.test(since) || extra) return `report takes one duration such as 30m, 2h or 3d. ${HELP}`
    const py = await python($)
    if (!py) return NO_PYTHON
    const r = await $.process.run([py, '-I', `${$.plugin.root}/sampler/sampler.py`, 'report', '--since', since], {
      timeoutMs: 30_000,
    })
    return r.stdout.trim() || r.stderr.trim() || 'no samples'
  }
  if (cmd === 'view') return toggleView($)
  if (cmd === 'help') return HELP
  return askClaude($, args.trim(), HELP)
}

export const register: Register = (on, options) => {
  settings = settingsFrom(options as Record<string, unknown>)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'monitor',
      description: 'RAM/CPU monitor (macOS): bare toggles on/off | on | off | view (toggle status line / above prompt) | report [2h]',
      argumentHint: '[on|off|view|report]',
      immediate: true,
    })
    if (!(await isMac($))) return started
    $.ui.status(undefined)
    await update($, line, () => null)
    const p = await where($)
    if (await $.fs.exists(p.plist)) {
      await $.fs.write(p.seen, String(Math.round((await $.clock.now()) / 1000))).catch(() => {})
      await install($, undefined, true).catch(() => {})
    }
    if (e.isInteractive) $.clock.every(settings.sampleSeconds * 1000, () => void refresh($))
    await refresh($)
    return started
  })

  on('command.run', { command: 'monitor' }, async ($, e) => {
    const text = await runCommand($, e.args)
    if (macos) await refresh($, true)
    return { text }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const text = await read($, line)
    if (!text || e.props.hasSurvey || settings.placement === 'status-line') return next(e)
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>{text}</Text>
  })
}
