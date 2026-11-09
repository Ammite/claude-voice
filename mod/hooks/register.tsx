import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BandView, Phase, VoiceSession } from '../types'

// Where listener/ lives: beside the mod folder when loaded from the repo
// (CLAUDE_CODE_PLUGIN_DIRS=<repo>/mod), else $VOICE_WAKE_LISTENER_DIR.
const BUSY_RETRY_MS = 30_000
const HEARTBEAT_MS = 5_000
const STALE_MS = 20_000 // a session not heard from this long counts as closed
const ACK_MS = 4_000 // a chosen session that has not taken voice this long: it goes to the mic's session
const PANE = 'voice-sessions'
// Voice prompts are sent with this mark; the system prompt asks Claude to end
// the reply to such a prompt with a SPEAK line, which the listener reads aloud.
const VOICE_MARK = '🎙'
const SPEAK = '🔊'
const SPEECH_RULE = `Voice replies: a user message that starts with ${VOICE_MARK} was dictated by voice, and one line of your reply to it is read aloud by an English text-to-speech voice when the reply is done. For such messages only, begin your final reply (the text after your last tool call) with one line: "${SPEAK} " followed by one short plain-English sentence (at most 50 words) giving the outcome or the answer, even when the rest of the reply is in another language. No markdown, code, file paths or URLs in that line. Never add it to messages without ${VOICE_MARK}.`

const phase = atom({ plugin: 'voice-wake', key: 'phase' } as const, 'off', { shape: 'phase-1' })
const sessions = atom({ plugin: 'voice-wake', key: 'sessions' } as const, [], { shape: 'sessions-3' })
const view = atom({ plugin: 'voice-wake', key: 'view' } as const, { said: '', err: '', elapsed: 0 }, { shape: 'view-2' })

const STATUS: Record<Phase, string> = {
  off: '🎙 off',
  loading: '🎙 loading…',
  listening: '🎙 listening',
  recording: '🎙 ● запись',
  transcribing: '🎙 распознаю…',
  speaking: '🔊 говорю…',
  busy: '🎙 busy (другой сеанс)',
  restarting: '🎙 restarting…',
  error: '🎙 error',
  'not-installed': '🎙 not installed',
}

// A listener line. `cmd` comes from a voice command (no end word): «Клод, какая сессия»
// (which), «Клод, сессия три» (session, n), «Клод, сотри» (clear the prompt box).
type Line = { text?: string; submit?: boolean; status?: string; stop?: boolean; cmd?: 'which' | 'session' | 'clear'; n?: number }
// What each session writes about itself into listener/sessions/<id>.json.
type Entry = {
  id: string
  folder: string
  label: string
  seen: number
  project?: string
  branch?: string
  since?: number // when the session first wrote here: the list's order
  closed?: boolean
}

let child: AsyncGenerator<unknown, unknown> | undefined
let runningTurn: string | undefined // the main loop's turn in progress, for «Клод стоп»
let dir: string | undefined // the listener folder
let selfId = ''
let label = ''
let since = 0
let recTimer: { cancel: () => void } | undefined // ticks the recording's time on the band
let inboxSeen: number | undefined // seq of the last inbox message taken here

// Sessions find each other through files in listener/sessions/ (the mod API
// has no way to list sessions, and session.send would reach the other session
// as a peer's message, not as the person's prompt):
//   <id>.json   each session's heartbeat (folder, last prompt, time)
//   <id>.inbox  the last message routed to it: { seq, text, submit }
//   <id>.ack    the seq it took; none within ACK_MS and the sender delivers it itself
//   target      the id voice input goes to; empty or stale = the mic's own session
//   owner       the session whose listener holds the mic
// ponytail: $.fs cannot delete, so files of closed sessions stay (a few hundred bytes each).
const reg = () => `${dir}/sessions`

async function readJson<T>($: EngineInterface, path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await $.fs.read(path)) as T
  } catch {
    return undefined
  }
}

async function readTarget($: EngineInterface) {
  return (await $.fs.read(`${reg()}/target`).catch(() => '')).trim()
}

async function aliveEntries($: EngineInterface): Promise<Entry[]> {
  const now = await $.clock.now()
  const files = await $.fs.list(reg()).catch(() => [])
  const entries = await Promise.all(
    files.filter(f => f.name.endsWith('.json')).map(f => readJson<Entry>($, `${reg()}/${f.name}`)),
  )
  return entries.filter((e): e is Entry => !!e && !e.closed && now - e.seen < STALE_MS)
}

async function refreshSessions($: EngineInterface) {
  if (!dir) return
  const [alive, chosen, owner] = await Promise.all([
    aliveEntries($),
    readTarget($),
    $.fs.read(`${reg()}/owner`).catch(() => ''),
  ])
  // No choice (or a closed one): voice goes to the mic's session.
  const target = alive.some(e => e.id === chosen) ? chosen : owner.trim()
  // This session first, then the others in the order they appeared: a new one
  // goes last, so the numbers already shown stay. The place is /claude-voice-to's number.
  const order = alive.sort(
    (a, b) =>
      Number(b.id === selfId) - Number(a.id === selfId) || (a.since ?? 0) - (b.since ?? 0) || a.id.localeCompare(b.id),
  )
  const names = order.map(where)
  const list: VoiceSession[] = order.map((e, i) => ({
    id: e.id,
    // Two sessions on the same branch: tell them apart by their id.
    name: names.indexOf(names[i]) === names.lastIndexOf(names[i]) ? names[i] : `${names[i]} (${e.id.slice(0, 4)})`,
    isSelf: e.id === selfId,
    isTarget: e.id === target,
    hasMic: e.id === owner.trim(),
  }))
  await update($, sessions, () => list)
}

/** How a session is named everywhere: `project · branch`, the branch left out when unknown. */
const where = (s: { project?: string; folder: string; branch?: string }) =>
  [s.project || s.folder, (s.branch ?? '').replace(/^claude\//, '')].filter(Boolean).join(' · ')

/** The repository's name (a worktree's main checkout, not the worktree folder)
 * and the checked-out branch, read from .git/HEAD; '' where unknown. */
async function gitInfo($: EngineInterface, cwd: string) {
  const repo = await $.session.repo().catch(() => null)
  const project = (repo?.root ?? cwd).split(/[\\/]/).filter(Boolean).pop() ?? ''
  let head = await $.fs.read(`${cwd}/.git/HEAD`).catch(() => '')
  if (!head) {
    // A worktree's .git is a file: "gitdir: <its folder in the main .git>".
    const gitdir = (await $.fs.read(`${cwd}/.git`).catch(() => '')).match(/^gitdir:\s*(.+)$/m)?.[1]?.trim()
    if (gitdir) {
      const abs = /^([a-zA-Z]:)?[\\/]/.test(gitdir) ? gitdir : `${cwd}/${gitdir}`
      head = await $.fs.read(`${abs}/HEAD`).catch(() => '')
    }
  }
  const branch = head.match(/^ref: refs\/heads\/(.+)$/m)?.[1]?.trim() ?? head.trim().slice(0, 7)
  return { project, branch }
}

async function heartbeat($: EngineInterface, closed = false) {
  if (!dir) return
  const cwd = await $.session.cwd()
  const folder = cwd.split(/[\\/]/).filter(Boolean).pop() ?? ''
  const entry: Entry = { id: selfId, folder, label, seen: await $.clock.now(), since, ...(await gitInfo($, cwd)) }
  await $.fs.write(`${reg()}/${selfId}.json`, JSON.stringify(closed ? { ...entry, closed } : entry))
  if (!closed) await refreshSessions($)
}

async function select($: EngineInterface, id: string) {
  if (!dir) return
  // Choosing the mic's session is the default: voice then follows the mic.
  const owner = (await $.fs.read(`${reg()}/owner`).catch(() => '')).trim()
  await $.fs.write(`${reg()}/target`, id === owner ? '' : id)
  await refreshSessions($)
}

async function checkInbox($: EngineInterface) {
  if (!dir) return
  const msg = await readJson<Line & { seq: number }>($, `${reg()}/${selfId}.inbox`)
  const seq = msg?.seq ?? 0
  // A new session takes nothing that was waiting before it started.
  if (inboxSeen === undefined) inboxSeen = seq
  if (!msg || seq <= inboxSeen) return
  inboxSeen = seq
  // Too late: the sender has already put it in its own session.
  if ((await $.clock.now()) - seq > ACK_MS) return
  await $.fs.write(`${reg()}/${selfId}.ack`, String(seq))
  await deliver($, msg)
}

async function setPhase($: EngineInterface, p: Phase) {
  $.ui.status(STATUS[p])
  recTimer?.cancel()
  recTimer = undefined
  if (p === 'recording') {
    // The band counts the recording's seconds.
    await update($, view, v => ({ ...v, elapsed: 0 }))
    recTimer = $.clock.every(1_000, () => void update($, view, v => ({ ...v, elapsed: v.elapsed + 1 })))
  }
  if (p === 'speaking' && dir) {
    // What is spoken: whichever session wrote it, it also left it in `said`.
    const said = (await $.fs.read(`${dir}/said`).catch(() => '')).trim()
    await update($, view, v => ({ ...v, said }))
  }
  await update($, phase, () => p)
}

async function listenerDir($: EngineInterface): Promise<string | undefined> {
  const fallback = await $.env.get('VOICE_WAKE_LISTENER_DIR')
  for (const d of [`${$.plugin.root}/../listener`, fallback]) {
    if (!d) continue
    const st = await $.fs.stat(`${d}/.venv/Scripts/python.exe`).catch(() => undefined)
    if (st) return d
  }
  return undefined
}

async function isEnabled($: EngineInterface) {
  return (await $.store.get('enabled')) !== false
}

/** The reply's spoken line (the last SPEAK line, wherever it stands), as plain text, or undefined. */
function spokenLine(answer: string): string | undefined {
  const lines = answer.split('\n').filter(l => l.trim().startsWith(SPEAK))
  const last = lines.at(-1)?.trim().slice(SPEAK.length).replace(/[*_`#>]/g, '').trim()
  return last || undefined
}

/** A voice prompt the engine did not take (a Stop pressed while it waited, a
 * limit): put it back in the box so it is not lost, and say so. */
async function giveBack($: EngineInterface, text: string, why: string) {
  const box = await $.prompt.read()
  await $.prompt.fill({ text: [box.text.trim(), text].filter(Boolean).join(' '), mode: 'replace' })
  $.ui.toast(`🎙 Не отправилось (${why}): текст в поле ввода, нажми Enter`)
  $.ui.log(`voice-wake: prompt dropped: ${why}`)
}

/** Have the mic's listener say `text` (and keep it on the band); a toast too, for when speech is off. */
async function sayAloud($: EngineInterface, text: string) {
  $.ui.toast(`🎙 ${text}`)
  if (!dir || !(await isEnabled($))) return
  await $.fs.write(`${dir}/said`, text)
  await $.fs.write(`${dir}/say`, text)
}

/** «Клод, какая сессия» and «Клод, сессия n»: the numbers are the sessions pane's. */
async function voiceCommand($: EngineInterface, line: Line) {
  await refreshSessions($)
  const list = await read($, sessions)
  const spoken = (s: VoiceSession) => s.name.replace(/ · /g, ', ')
  if (line.cmd === 'which') {
    const i = list.findIndex(s => s.isTarget)
    return sayAloud($, i < 0 ? 'Voice goes to this session.' : `Voice goes to session ${i + 1}, ${spoken(list[i])}.`)
  }
  const n = line.n ?? 0
  const chosen = list[n - 1]
  if (!chosen) return sayAloud($, `There is no session ${n}. There are ${list.length}.`)
  await select($, chosen.id)
  return sayAloud($, `Session ${n}, ${spoken(chosen)}.`)
}

async function deliver($: EngineInterface, line: Line) {
  if (line.cmd === 'clear') {
    await $.prompt.fill({ text: '', mode: 'replace' })
    return
  }
  if (line.stop) {
    if (!runningTurn) return
    await $.turn.abort({ turnId: runningTurn }).catch(() => undefined) // it may have just ended
    $.ui.toast('🎙 Остановлено')
    return
  }
  const spoken = line.text?.trim() ?? ''
  const box = await $.prompt.read()
  if (line.submit) {
    // Send what was dictated before (inserted, unsent) together with this phrase.
    const full = [box.text.trim(), spoken].filter(Boolean).join(' ')
    if (!full) return
    if (box.text) await $.prompt.fill({ text: '', mode: 'replace' })
    // Not awaited: a prompt sent while Claude works waits for the turn to end,
    // and the listener's next lines («Клод стоп») must not wait with it.
    void $.prompt.submit({ text: `${VOICE_MARK} ${full}`, asUser: true }).then(
      r => r.drop !== undefined && giveBack($, full, r.drop),
      err => giveBack($, full, String(err)),
    )
    return
  }
  if (!spoken) return
  const before = box.text.slice(0, box.cursor)
  const sep = before && !/\s$/.test(before) ? ' ' : ''
  const filled = await $.prompt.fill({ text: sep + spoken, mode: 'insert' })
  if (!filled.isFilled) $.ui.toast(`🎙 не вставилось (${filled.refusal ?? 'unknown'}): ${spoken}`)
}

/** Deliver here, or to the session chosen in the sessions pane. */
async function route($: EngineInterface, line: Line) {
  const target = await readTarget($)
  if (target && target !== selfId) {
    const entry = (await aliveEntries($)).find(e => e.id === target)
    if (entry) {
      const seq = await $.clock.now()
      await $.fs.write(`${reg()}/${target}.inbox`, JSON.stringify({ seq, ...line }))
      // No ack in time (the session hangs, an old mod there): deliver here instead.
      $.clock.after(ACK_MS, async () => {
        if (Number(await $.fs.read(`${reg()}/${target}.ack`).catch(() => '0')) >= seq) return
        $.ui.toast(`🎙 сессия ${where(entry)} не приняла голос: текст здесь`)
        await deliver($, line)
      })
      return
    }
    $.ui.toast('🎙 выбранная сессия закрыта: текст вставлен сюда')
  }
  await deliver($, line)
}

async function run($: EngineInterface) {
  if (child || !(await isEnabled($))) return
  if (!dir) {
    await setPhase($, 'not-installed')
    $.ui.log(`voice-wake: no listener venv found; run python listener/install.py`)
    return
  }
  await setPhase($, 'loading')
  const proc = $.process.spawn({
    argv: [`${dir}/.venv/Scripts/python.exe`, '-u', `${dir}/listen.py`],
    cwd: dir,
    env: { PYTHONIOENCODING: 'utf-8' },
  })
  child = proc
  const startedAt = await $.clock.now()
  let buf = ''
  let busy = false
  let errTail = ''
  try {
    for await (const { stream, text } of proc) {
      if (stream === 'stderr') {
        errTail = (errTail + text).slice(-300)
        continue
      }
      buf += text
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const raw of lines) {
        let line: Line
        try {
          line = JSON.parse(raw)
        } catch {
          continue
        }
        if (line.status === 'ready') {
          if (dir) await $.fs.write(`${reg()}/owner`, selfId)
          await setPhase($, 'listening')
        }
        if (line.status === 'recording') await setPhase($, 'recording')
        if (line.status === 'transcribing') await setPhase($, 'transcribing')
        if (line.status === 'speaking') await setPhase($, 'speaking')
        if (line.status === 'busy') busy = true
        if (line.cmd === 'which' || line.cmd === 'session') await voiceCommand($, line)
        if (line.text !== undefined || line.stop || line.cmd === 'clear') await route($, line)
      }
    }
  } catch (err) {
    $.ui.log(`voice-wake: listener failed: ${String(err)}`)
  }
  const stoppedByUs = child !== proc
  if (child === proc) child = undefined
  if (stoppedByUs || !(await isEnabled($))) return
  if (busy) {
    // Another session owns the mic; take over once it lets go.
    await setPhase($, 'busy')
    $.clock.after(BUSY_RETRY_MS, () => void run($))
  } else if ((await $.clock.now()) - startedAt > 60_000) {
    // It ran a while, then died (killed, a crash mid-session): start it again.
    // ponytail: a listener that dies every minute restarts forever; cap it if that happens.
    await setPhase($, 'restarting')
    $.clock.after(5_000, () => void run($))
  } else {
    // The band shows the last line of stderr: usually the cause (no mic, no model).
    const err = errTail.trim().split('\n').at(-1)?.trim() ?? ''
    await update($, view, v => ({ ...v, err }))
    await setPhase($, 'error')
    $.ui.log(`voice-wake: listener exited. ${errTail.trim()}`)
  }
}

async function setEnabled($: EngineInterface, enable: boolean) {
  await $.store.set('enabled', enable)
  if (enable) return run($)
  const proc = child
  child = undefined
  void proc?.return(undefined)
  await setPhase($, 'off')
}

async function send($: EngineInterface, cmd: 'dictate' | 'stop') {
  if (dir) await $.fs.write(`${dir}/cmd`, cmd)
}

/** /claude-voice, -on, -off: the setting is shared by every session. */
async function toggle($: EngineInterface, enable: boolean) {
  void setEnabled($, enable)
  return enable
    ? { text: 'Голосовой ввод включён: скажи «Клод приём», сообщение и «приём» в конце.' }
    : { text: 'Голосовой ввод выключен (во всех сеансах).' }
}

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'Голосовой ввод: сессии' })

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'claude-voice', description: 'Голосовой ввод «Клод приём»: включить / выключить' })
    await $.command.register({ name: 'claude-voice-on', description: 'Голосовой ввод: включить во всех сеансах' })
    await $.command.register({ name: 'claude-voice-off', description: 'Голосовой ввод: выключить во всех сеансах (микрофон, речь)' })
    await $.command.register({
      name: 'claude-voice-to',
      description: 'Куда идёт голосовой ввод: без аргумента — список сессий, с номером — выбрать',
      argumentHint: '[номер сессии]',
    })
    dir = await listenerDir($)
    selfId = await $.session.id()
    if (dir) {
      const old = await readJson<Entry>($, `${reg()}/${selfId}.json`)
      label = old?.label ?? ''
      since = old?.since ?? (await $.clock.now()) // a reload keeps its place in the list
      await heartbeat($)
      await checkInbox($) // marks what waits there as seen
      $.clock.every(HEARTBEAT_MS, () => void heartbeat($))
      $.clock.every(1_000, () => void checkInbox($))
    }
    if (await isEnabled($)) void run($)
    else await setPhase($, 'off')
    return started
  })

  on('session.end', async ($, e, next) => {
    await heartbeat($, true).catch(() => undefined)
    return next(e)
  })

  // Ask for a short English line to speak on voice prompts. Always in the prompt
  // (not only on voice turns) so the system prompt stays cached.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    return { ...r, sections: [...r.sections, { id: 'voice-wake:speech', text: SPEECH_RULE, scope: 'session' as const }] }
  })

  // The main loop's reply ended: hand its spoken line to the listener (whichever
  // session's listener holds the mic speaks it).
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) runningTurn = e.turnId
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId && e.turnId === runningTurn) runningTurn = undefined
    const r = await next(e)
    const say = e.reason === 'answer' && !e.agentId ? spokenLine(e.answer) : undefined
    if (say && dir && (await isEnabled($))) {
      // The listener takes `say`; `said` stays for the band while it speaks.
      await $.fs.write(`${dir}/said`, say)
      await $.fs.write(`${dir}/say`, say)
    }
    return r
  })

  // The last prompt names the session in the list.
  on('prompt.submit', async ($, e, next) => {
    label = e.text.replace(VOICE_MARK, '').replace(/\s+/g, ' ').trim().slice(0, 60) || label
    return next(e)
  })

  on('command.run', { command: 'claude-voice' }, async $ => toggle($, !(await isEnabled($))))
  on('command.run', { command: 'claude-voice-on' }, async $ => toggle($, true))
  on('command.run', { command: 'claude-voice-off' }, async $ => toggle($, false))

  on('command.run', { command: 'claude-voice-to' }, async ($, e) => {
    await refreshSessions($)
    const list = await read($, sessions)
    const n = Number.parseInt(e.args.trim(), 10)
    if (Number.isNaN(n)) {
      void openPane($)
      const tags = (s: VoiceSession) => [s.isSelf && 'эта', s.hasMic && 'микрофон'].filter(Boolean).join(', ')
      return {
        text:
          list.map((s, i) => `${i + 1}. ${s.name}${tags(s) ? ` (${tags(s)})` : ''}${s.isTarget ? ' ← голос сюда' : ''}`).join('\n') ||
          'Нет сессий с модом.',
      }
    }
    const chosen = list[n - 1]
    if (!chosen) return { text: `Нет сессии №${n}: их ${list.length}.` }
    await select($, chosen.id)
    return { text: `Голосовой ввод теперь идёт в: ${chosen.name}` }
  })

  // The sessions pane: this session first, then the others in the order they
  // appeared; the number is the one /claude-voice-to and «Клод, сессия n» take, and its hotkey.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, sessions)
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold dimColor>
          Куда идёт голос
        </Text>
        <Box flexDirection="column">
          {list.map((s, i) => (
            <Button
              key={s.id}
              hotkey={i < 9 ? String(i + 1) : undefined}
              variant={s.isTarget ? 'primary' : undefined}
              onPress={() => void select($, s.id)}
            >
              {s.isTarget ? '✓ ' : '   '}
              {`${i + 1}. ${s.name} `}
              <Text dimColor>{[s.isSelf ? 'эта' : '', s.hasMic ? '🎙 микрофон' : ''].filter(Boolean).join(' · ')}</Text>
            </Button>
          ))}
        </Box>
        {list.length === 0 && <Text dimColor>Нет сессий с модом.</Text>}
        <Text dimColor>Без выбора голос идёт в сессию с микрофоном. Номер = /claude-voice-to n или «Клод, сессия n».</Text>
      </Box>
    )
  })

  // The band above the prompt: one frame for every state — what the listener
  // does, where voice goes (always), the main button, «Выключить» last and dim.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const p = await read($, phase)
    const list = await read($, sessions)
    const v = await read($, view)
    const target = list.find(s => s.isTarget)
    const toPane = () => void openPane($)
    const chip = (
      <Button key="target" dimColor onPress={toPane}>
        {!target || target.isSelf ? '→ эта сессия' : `→ ${target.name}`}
      </Button>
    )
    const turnOff = <Button key="Выключить" label="Выключить" dimColor onPress={() => void setEnabled($, false)} />
    const btn = (name: string, press: () => void) => (
      <Button key={name} label={name} variant="primary" onPress={press} />
    )
    const row = (o: { title: string; hint?: string; color?: string; dim?: boolean; parts?: (typeof chip)[] }) => (
      <Box gap={1} alignItems="center">
        <Text bold={!o.dim} dimColor={o.dim} color={o.color}>
          {o.title}
        </Text>
        {o.hint ? <Text dimColor>{o.hint}</Text> : null}
        {o.parts}
      </Box>
    )
    const mmss = `${Math.floor(v.elapsed / 60)}:${String(v.elapsed % 60).padStart(2, '0')}`
    switch (p) {
      case 'listening':
        return row({ title: '🎙 Слушаю', hint: 'скажи «Клод, приём»', parts: [chip, btn('Диктовать', () => void send($, 'dictate')), turnOff] })
      case 'recording':
        return row({ title: `● Запись ${mmss}`, color: 'red', hint: 'закончи словом «приём»', parts: [chip, btn('Готово', () => void send($, 'stop'))] })
      case 'transcribing':
        return row({ title: '🎙 Распознаю', hint: 'текст появится в поле ввода', parts: [chip] })
      case 'speaking':
        return row({ title: '🔊 Говорю', hint: v.said ? `«${v.said}»` : undefined, parts: [btn('Замолчать', () => void send($, 'stop'))] })
      case 'loading':
        return row({ title: '🎙 Загружаю модели', hint: 'Vosk и Whisper, первый запуск дольше', parts: [turnOff] })
      case 'restarting':
        return row({ title: '🎙 Перезапускаю слушатель', parts: [turnOff] })
      case 'busy': {
        const mic = list.find(s => s.hasMic)
        const here = target?.isSelf ? [chip] : [btn('Голос сюда', () => void select($, selfId))]
        return row({
          title: '🎙 Микрофон у сессии',
          color: 'yellow',
          hint: mic ? mic.name : 'другого сеанса Claude',
          parts: [...here, <Button key="Выключить везде" label="Выключить везде" dimColor onPress={() => void setEnabled($, false)} />],
        })
      }
      case 'error':
        return row({ title: '🎙 Слушатель упал', color: 'red', hint: v.err || 'подробности в listener/listen.log', parts: [btn('Перезапустить', () => void setEnabled($, true))] })
      case 'not-installed':
        return row({ title: '🎙 Нужна установка', hint: 'python listener/install.py' })
      case 'off':
        return row({ title: '🎙 Голосовой ввод выключен', dim: true, parts: [<Button key="Включить" label="Включить" onPress={() => void setEnabled($, true)} />] })
    }
  })
}
