import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// The in-memory file system keeps listener files as /listener/..., wherever the
// mod is checked out (beside the repo's listener/ or at the fallback path).
const sessionsDir = () => '/listener/sessions'

// The engine beneath the mod: what every test here needs answered, with an
// in-memory file system (returned) for listener/sessions/.
function engine(on: Parameters<TestBody>[1], id = 'self', afterFires = false, cwd = '/work/proj', exists = (_path: string) => true) {
  const files = new Map<string, string>()
  // The engine hands paths resolved for this OS (C:\work\...): keep them as /work/...
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '').replace(/^.*\/listener\//, '/listener/')
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: id }))
  on('env.get', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: cwd }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('store.get', () => ({ value: undefined }))
  on('fs.stat', (_, e) => (exists(e.path) ? { value: { kind: 'file', size: 1 } as never } : { deny: 'ENOENT' }))
  on('fs.read', (_, e) => {
    const text = files.get(norm(e.path))
    if (text === undefined) return { deny: 'ENOENT' }
    return { value: text }
  })
  on('fs.write', (_, e) => {
    files.set(norm(e.path), e.text)
    return { value: undefined }
  })
  on('fs.list', (_, e) => {
    const d = norm(e.path ?? '') + '/'
    return { value: [...files.keys()].filter(k => k.startsWith(d)).map(k => ({ name: k.slice(d.length), kind: 'file' }) as never) }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.now', () => ({ value: 1_000 }))
  // Timers run only when a test ticks them, so no test loops on its own.
  const waiting: (() => void)[] = []
  const clock = { tick: () => waiting.splice(0).forEach(go => go()) }
  on('clock.every', () => new Promise<{ value: undefined }>(r => waiting.push(() => r({ value: undefined }))))
  on('clock.after', () => (afterFires ? { value: undefined } : new Promise<never>(() => {})))
  const file = (suffix: string) => [...files.entries()].find(([k]) => k.endsWith(suffix))
  return { files, file, norm, clock, toasts }
}

const BAND = {
  plugin: 'voice-wake',
  component: 'AbovePrompt',
  surface: 'desktop',
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 80, scroll: { offset: 0, bodyRows: 4 }, view: {} },
} as const

const voiceTo = (args: string) => ({
  command: 'claude-voice-to',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 80 },
})

// The listener's lines reach the band through the mod's own async loop: poll.
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 500 && !(await check()); i++);
}

test('a phrase is inserted; one ending in "отправь" sends the draft with it', async ($, on) => {
  engine(on)
  const fills: unknown[] = []
  const submits: string[] = []
  let draft = 'было'
  let done!: () => void
  const finished = new Promise<void>(r => (done = r))

  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('prompt.fill', (_, e) => {
    fills.push({ text: e.text, mode: e.mode })
    draft = e.mode === 'replace' ? e.text : draft + e.text
    return { isFilled: true }
  })
  on('prompt.submit', (_, e) => {
    submits.push(e.text)
    done()
    return { text: e.text }
  })
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: '{"status": "ready"}\n{"text": "привет", "sub' }
    yield { stream: 'stdout' as const, text: 'mit": false}\n{"text": "\\u043c\\u0438\\u0440", "submit": true}\n' }
    await new Promise(() => {}) // the listener keeps running
    return { value: { code: 0, signal: null } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await finished

  expect(fills[0]).toEqual({ text: ' привет', mode: 'insert' })
  expect(submits).toEqual(['🎙 было привет мир'])
})

test('the band: "Диктовать" tells the listener, then shows the recording with "Готово"', async ($, on) => {
  const { file } = engine(on)
  let recording!: () => void
  const recordingNow = new Promise<void>(r => (recording = r))
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: '{"status": "ready"}\n' }
    await recordingNow
    yield { stream: 'stdout' as const, text: '{"status": "recording"}\n' }
    await new Promise(() => {})
    return { value: { code: 0, signal: null } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount(BAND)
  await until(async () => (await ui.find({ key: 'Диктовать' })) !== undefined)

  await ui.press({ key: 'Диктовать' })
  expect(file('/listener/cmd')?.[1]).toBe('dictate')

  recording()
  await until(async () => (await ui.find({ key: 'Готово' })) !== undefined)
  await ui.press({ key: 'Готово' })
  expect(file('/listener/cmd')?.[1]).toBe('stop')
  await ui.unmount()
})

test('voice goes to the session chosen with /claude-voice-to, through its inbox', async ($, on) => {
  const { files, file } = engine(on, 'aaa')
  const submits: string[] = []
  let heard!: () => void
  const said = new Promise<void>(r => (heard = r))
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.submit', (_, e) => {
    submits.push(e.text)
    return { text: e.text }
  })
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: '{"status": "ready"}\n' }
    await said
    yield { stream: 'stdout' as const, text: '{"text": "привет", "submit": true}\n' }
    await new Promise(() => {})
    return { value: { code: 0, signal: null } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // Another session with the mod, alive, in the same registry.
  const reg = file('/aaa.json')![0].replace(/\/aaa\.json$/, '')
  files.set(`${reg}/bbb.json`, JSON.stringify({ id: 'bbb', folder: 'other', label: 'вторая', seen: 1_000 }))

  const listed = await $.command.run(voiceTo(''))
  expect(listed.text).toContain('other')
  const n = Number(listed.text!.split('\n').find(l => l.includes('other'))!.match(/^(\d+)\./)![1])
  await $.command.run(voiceTo(String(n)))
  expect(files.get(`${reg}/target`)).toBe('bbb')

  heard()
  await until(async () => files.has(`${reg}/bbb.inbox`))
  expect(JSON.parse(files.get(`${reg}/bbb.inbox`)!)).toMatchObject({ text: 'привет', submit: true })
  expect(submits).toEqual([])
  // Let the routing set its ack timer before the test ends.
  for (let i = 0; i < 20; i++) await (await $.ui.mount(BAND)).unmount()
})

test("voice the chosen session does not take in time is sent here instead, with a warning", async ($, on) => {
  const { files, toasts } = engine(on, 'aaa', true)
  const submits: string[] = []
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.submit', (_, e) => {
    submits.push(e.text)
    return { text: e.text }
  })
  const reg = sessionsDir()
  files.set(`${reg}/bbb.json`, JSON.stringify({ id: 'bbb', folder: 'other', label: 'вторая', seen: 1_000 }))
  files.set(`${reg}/target`, 'bbb')
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: '{"status": "ready"}\n{"text": "привет", "submit": true}\n' }
    await new Promise(() => {})
    return { value: { code: 0, signal: null } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await until(async () => submits.length > 0)
  expect(submits).toEqual(['🎙 привет'])
  expect(toasts.join()).toContain('other')
})

test('a session submits what lands in its inbox, not what waited there before it started', async ($, on) => {
  const { files, clock } = engine(on, 'bbb')
  const submits: string[] = []
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.submit', (_, e) => {
    submits.push(e.text)
    return { text: e.text }
  })
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: '{"status": "busy"}\n' }
    await new Promise(() => {}) // stays busy for the test's length
    return { value: { code: 3, signal: null } }
  })
  const inbox = `${sessionsDir()}/bbb.inbox`
  files.set(inbox, JSON.stringify({ seq: 5, text: 'старое', submit: true }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  files.set(inbox, JSON.stringify({ seq: 6, text: 'новое', submit: true }))
  clock.tick() // the timers' next period: the inbox is read
  await until(async () => submits.length > 0)
  expect(submits).toEqual(['🎙 новое'])
  expect(files.get(`${sessionsDir()}/bbb.ack`)).toBe('6')
  // The tick also ran a heartbeat; let it finish before the test ends.
  // (a mount and unmount is a full round trip through the engine).
  for (let i = 0; i < 20; i++) await (await $.ui.mount(BAND)).unmount()
})

test("a reply's 🔊 line goes to the listener to speak; a reply without one, a subagent's or an aborted one does not", async ($, on) => {
  const { file, files } = engine(on)
  on('process.spawn', async function* () {
    await new Promise(() => {})
    return { value: { code: 0, signal: null } }
  })
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const end = (answer: string, more = {}) =>
    $.turn.complete({ answer, reason: 'answer', durationMs: 1, isAborted: false, turnId: 't', ...more } as never)

  await end('🔊 Done, the **tests** pass.\n\nСделал.')
  expect(file('/listener/say')?.[1]).toBe('Done, the tests pass.')

  files.clear()
  await end('Просто ответ без строки.')
  await end('🔊 From a subagent.', { agentId: 'a1' })
  await end('🔊 Cut off.', { reason: 'aborted', isAborted: true })
  expect(file('/listener/say')).toBe(undefined)
})

test('«Клод стоп» from the listener aborts the running turn', async ($, on) => {
  engine(on)
  const aborted: string[] = []
  let done!: () => void
  const finished = new Promise<void>(r => (done = r))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.abort', (_, e) => {
    aborted.push(e.turnId)
    done()
  })
  let stopNow!: () => void
  const turnStarted = new Promise<void>(r => (stopNow = r))
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: '{"status": "ready"}\n' }
    await turnStarted
    yield { stream: 'stdout' as const, text: '{"stop": true}\n' }
    await new Promise(() => {})
    return { value: { code: 0, signal: null } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'открой браузер', turnId: 'turn-1' } as never)
  stopNow()
  await finished
  expect(aborted).toEqual(['turn-1'])
})

test('a voice prompt the engine drops (a Stop pressed while it waited) goes back into the box', async ($, on) => {
  engine(on)
  let draft = ''
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('prompt.fill', (_, e) => {
    draft = e.mode === 'replace' ? e.text : draft + e.text
    return { isFilled: true }
  })
  on('prompt.submit', () => ({ drop: 'stopped' }))
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: '{"status": "ready"}\n{"text": "1, 2, 3", "submit": true}\n' }
    await new Promise(() => {})
    return { value: { code: 0, signal: null } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await until(async () => draft !== '')
  expect(draft).toBe('1, 2, 3')
})

test('a session is named project · branch, this one first; choosing the mic session is the default', async ($, on) => {
  const cwd = '/r/claude-voice/.claude/worktrees/wt1'
  const { files } = engine(on, 'self', false, cwd)
  on('session.repo', () => ({ value: { root: '/r/claude-voice', remote: null, internal: false, name: null } }))
  on('process.spawn', async function* () {
    await new Promise(() => {})
    return { value: { code: 0, signal: null } }
  })
  // A worktree's .git is a file naming its folder in the main repository.
  files.set(`${cwd}/.git`, 'gitdir: /r/claude-voice/.git/worktrees/wt1\n')
  files.set('/r/claude-voice/.git/worktrees/wt1/HEAD', 'ref: refs/heads/claude/wt1\n')
  // A plain checkout elsewhere, older, already in the registry.
  files.set(`${sessionsDir()}/old.json`, JSON.stringify({ id: 'old', folder: 'api', project: 'api', branch: 'main', label: 'тест в auth', seen: 1_000, since: 1 }))
  await $.session.start({ cwd, surface: 'desktop', isInteractive: true })

  // A second session on the same branch, newer: told apart by its id.
  files.set(`${sessionsDir()}/twin1234.json`, JSON.stringify({ id: 'twin1234', folder: 'api', project: 'api', branch: 'main', label: '', seen: 1_000, since: 2 }))
  files.set(`${sessionsDir()}/owner`, 'old')

  const listed = (await $.command.run(voiceTo(''))).text!.split('\n')
  expect(listed).toEqual([
    '1. claude-voice · wt1 (эта)',
    '2. api · main (old) (микрофон) ← голос сюда',
    '3. api · main (twin)',
  ])

  await $.command.run(voiceTo('3'))
  expect(files.get(`${sessionsDir()}/target`)).toBe('twin1234')
  await $.command.run(voiceTo('2')) // the mic's session: back to the default
  expect(files.get(`${sessionsDir()}/target`)).toBe('')
  // Let the heartbeat's writes finish before the test ends.
  for (let i = 0; i < 20; i++) await (await $.ui.mount(BAND)).unmount()
})

test('a plain checkout: the branch is read from .git/HEAD', async ($, on) => {
  const { files, file } = engine(on)
  on('session.repo', () => ({ value: null }))
  on('process.spawn', async function* () {
    await new Promise(() => {})
    return { value: { code: 0, signal: null } }
  })
  files.set('/work/proj/.git/HEAD', 'ref: refs/heads/feature-x\n')
  await $.session.start({ cwd: '/work/proj', surface: 'desktop', isInteractive: true })
  expect(JSON.parse(file('/self.json')![1])).toMatchObject({ project: 'proj', branch: 'feature-x' })
  // Let the heartbeat's writes finish before the test ends.
  for (let i = 0; i < 20; i++) await (await $.ui.mount(BAND)).unmount()
})

test('«Клод, сессия 2» chooses the second session and says so; «сотри» goes to it; a missing number is said', async ($, on) => {
  const { files, file, toasts } = engine(on, 'aaa')
  const fills: unknown[] = []
  on('prompt.fill', (_, e) => {
    fills.push({ text: e.text, mode: e.mode })
    return { isFilled: true }
  })
  const reg = sessionsDir()
  files.set(`${reg}/bbb.json`, JSON.stringify({ id: 'bbb', folder: 'other', branch: 'claude/fix', label: '', seen: 1_000, since: 5 }))
  let go!: () => void
  const commands = new Promise<void>(r => (go = r))
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: '{"status": "ready"}\n' }
    await commands
    yield { stream: 'stdout' as const, text: '{"cmd": "session", "n": 2}\n' }
    yield { stream: 'stdout' as const, text: '{"cmd": "which"}\n{"cmd": "clear"}\n{"cmd": "session", "n": 7}\n' }
    await new Promise(() => {})
    return { value: { code: 0, signal: null } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  go()
  // A chain of engine calls per line: wait through engine round trips, not microtasks.
  for (let i = 0; i < 200 && !file('/listener/say')?.[1]?.startsWith('There is no'); i++) await (await $.ui.mount(BAND)).unmount()
  expect(files.get(`${reg}/target`)).toBe('bbb')
  // «Сотри» goes where voice goes: the chosen session clears its own box.
  expect(JSON.parse(files.get(`${reg}/bbb.inbox`)!)).toMatchObject({ cmd: 'clear' })
  expect(fills).toEqual([])
  expect(file('/listener/say')?.[1]).toBe('There is no session 7. There are 2.')
  expect(toasts).toEqual(['🎙 Session 2, other, fix.', '🎙 Voice goes to session 2, other, fix.', '🎙 There is no session 7. There are 2.'])
  for (let i = 0; i < 20; i++) await (await $.ui.mount(BAND)).unmount()
})

test('/claude-voice-off and /claude-voice-on turn voice input off and on', async ($, on) => {
  engine(on)
  const stored: unknown[] = []
  on('store.set', (_, e) => {
    stored.push(e.value)
    return { value: undefined }
  })
  on('process.spawn', async function* () {
    await new Promise(() => {})
    return { value: { code: 0, signal: null } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const run = (command: string) => $.command.run({ ...voiceTo(''), command })
  expect((await run('claude-voice-off')).text).toContain('выключен')
  expect((await run('claude-voice-on')).text).toContain('включён')
  await until(async () => stored.length === 2)
  expect(stored).toEqual([false, true])
  for (let i = 0; i < 20; i++) await (await $.ui.mount(BAND)).unmount()
})

test('with no choice, voice goes to the session Claude Desktop shows', async ($, on) => {
  const { files } = engine(on, 'aaa')
  const submits: string[] = []
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.submit', (_, e) => {
    submits.push(e.text)
    return { text: e.text }
  })
  const reg = sessionsDir()
  files.set(`${reg}/bbb.json`, JSON.stringify({ id: 'bbb', folder: 'other', label: '', seen: 1_000 }))
  files.set(`${reg}/focused`, 'bbb')
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: '{"status": "ready"}\n{"text": "привет", "submit": true}\n' }
    await new Promise(() => {})
    return { value: { code: 0, signal: null } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await until(async () => files.has(`${reg}/bbb.inbox`))
  expect(JSON.parse(files.get(`${reg}/bbb.inbox`)!)).toMatchObject({ text: 'привет', submit: true })
  expect(submits).toEqual([])
  const listed = (await $.command.run(voiceTo(''))).text!
  expect(listed).toContain('other (на экране) ← голос сюда')
  // Let the routing set its ack timer before the test ends.
  for (let i = 0; i < 20; i++) await (await $.ui.mount(BAND)).unmount()
})

test('choosing a session opens it in Claude Desktop; choosing the shown one clears the choice', async ($, on) => {
  const { files } = engine(on, 'aaa')
  const opened: string[][] = []
  on('process.spawn', async function* (_, e) {
    if (e.argv[0] === 'cmd') {
      opened.push([...e.argv])
      return { value: { code: 0, signal: null } }
    }
    await new Promise(() => {}) // the listener: stays quiet
    return { value: { code: 0, signal: null } }
  })
  const reg = sessionsDir()
  files.set(`${reg}/bbb.json`, JSON.stringify({ id: 'bbb', folder: 'other', label: '', seen: 1_000, since: 2 }))
  files.set(`${reg}/focused`, 'aaa')
  files.set(`${reg}/desktop-ids.json`, JSON.stringify({ bbb: 'local_b2', aaa: 'local_a1' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await $.command.run(voiceTo('2')) // bbb: not on screen
  expect(files.get(`${reg}/target`)).toBe('bbb')
  await until(async () => opened.length > 0)
  expect(opened).toEqual([['cmd', '/c', 'start', '', 'claude://claude.ai/epitaxy/local_b2']])

  await $.command.run(voiceTo('1')) // this one, on screen: the default again, nothing to open
  expect(files.get(`${reg}/target`)).toBe('')
  expect(opened.length).toBe(1)
  for (let i = 0; i < 20; i++) await (await $.ui.mount(BAND)).unmount()
})

test('on Linux the listener runs from the venv at .venv/bin/python', async ($, on) => {
  engine(on, 'self', false, '/work/proj', path => path.endsWith('/.venv/bin/python'))
  let spawned!: (argv: string[]) => void
  const argv = new Promise<string[]>(r => (spawned = r))
  on('process.spawn', async function* (_, e) {
    spawned([...e.argv])
    await new Promise(() => {})
    return { value: { code: 0, signal: null } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const [python, , script] = await argv
  expect(python.endsWith('/listener/.venv/bin/python')).toBe(true)
  expect(script.endsWith('/listener/listen.py')).toBe(true)
})

test('on Linux a chosen session opens through xdg-open', async ($, on) => {
  const { files } = engine(on, 'aaa', false, '/work/proj', path => !path.endsWith('.exe'))
  const opened: string[][] = []
  on('process.spawn', async function* (_, e) {
    if (e.argv[0] === 'xdg-open') {
      opened.push([...e.argv])
      return { value: { code: 0, signal: null } }
    }
    await new Promise(() => {}) // the listener: stays quiet
    return { value: { code: 0, signal: null } }
  })
  const reg = sessionsDir()
  files.set(`${reg}/bbb.json`, JSON.stringify({ id: 'bbb', folder: 'other', label: '', seen: 1_000, since: 2 }))
  files.set(`${reg}/focused`, 'aaa')
  files.set(`${reg}/desktop-ids.json`, JSON.stringify({ bbb: 'local_b2', aaa: 'local_a1' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await $.command.run(voiceTo('2')) // bbb: not on screen
  expect(files.get(`${reg}/target`)).toBe('bbb')
  await until(async () => opened.length > 0)
  expect(opened).toEqual([['xdg-open', 'claude://claude.ai/epitaxy/local_b2']])

  await $.command.run(voiceTo('1')) // this one, on screen: the default again, nothing to open
  expect(files.get(`${reg}/target`)).toBe('')
  expect(opened.length).toBe(1)
  for (let i = 0; i < 20; i++) await (await $.ui.mount(BAND)).unmount()
})

// The rule for the spoken line, as the system prompt holds it.
async function speechRule($: Parameters<TestBody>[0]) {
  return (await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['desktop'], tools: [], outputStyle: null, traits: [] })).sections.find(s => s.id === 'voice-wake:speech')?.text ?? ''
}

// Resolves once the listener is started: the session's start work is done.
function quietListener(on: Parameters<TestBody>[1]) {
  on('prompt.compose', () => ({ sections: [] }))
  let started!: () => void
  const spawned = new Promise<void>(r => (started = r))
  on('process.spawn', async function* () {
    started()
    await new Promise(() => {})
    return { value: { code: 0, signal: null } }
  })
  return spawned
}

test('the spoken line is asked for in reply_language from listener/config.json', async ($, on) => {
  const { files } = engine(on)
  files.set('/listener/config.json', JSON.stringify({ reply_language: 'ru' }))
  const spawned = quietListener(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await spawned
  expect(await speechRule($)).toContain('in Russian')
})

test('without a config, or with a broken one, the spoken line is in English', async ($, on) => {
  const { files } = engine(on)
  files.set('/listener/config.json', '{ not json')
  const spawned = quietListener(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await spawned
  expect(await speechRule($)).toContain('in English')
})
