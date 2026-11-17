#!/usr/bin/env node
/**
 * Offline smoke test for the dsh-live-run client bundle.
 *
 * Loads the REAL lib/client.js through a fake `window.__ModuleLoader__` and a
 * mini React runtime (createElement / useState / useMemo / useEffect), with
 * one hook-slot set PER MOUNT (as real React does), so the component's data
 * plumbing actually runs — no react-dom, no browser.
 *
 * Covered:
 *   1. bundle registration + plugin surface + tab registration
 *   2. mount with no session binding (empty states, jobs-service notice)
 *   3. mount against a live snapshot: current file, op list, running job text
 *   4. repaint when the conversation publishes a delta / a call starts running
 *   5. op extraction: read/write/edit/present/running/shell/failed/subCalls
 *   6. second factory execution (the page's HMR path)
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Resolved from this file, so the repo is self-contained wherever it is cloned. */
const BUNDLE = fileURLToPath(new URL('../lib/client.js', import.meta.url))

const WATCHDOG = setTimeout(() => { console.error('WATCHDOG: test did not finish in 8s'); process.exit(9) }, 8000)


// ─────────────────────── mini React runtime ───────────────────────
function createRuntime() {
  // Real React keys hook state by component instance, and a KEYED element is a
  // different instance when its key changes. Model both: per component type,
  // one slot array per React key (undefined = the unkeyed instance).
  const slotsByComponent = new Map()
  const DEFAULT_KEY = '\u0000unkeyed'
  let active = []
  let cursor = 0
  const effects = []

  function slotsOf(component, key) {
    let byKey = slotsByComponent.get(component)
    if (byKey === undefined) {
      byKey = new Map()
      slotsByComponent.set(component, byKey)
    }
    const name = key === undefined || key === null ? DEFAULT_KEY : String(key)
    let slots = byKey.get(name)
    if (slots === undefined) {
      slots = []
      byKey.set(name, slots)
    }
    return slots
  }

  function runWith(component, key, operation) {
    const previousActive = active
    const previousCursor = cursor
    active = slotsOf(component, key)
    cursor = 0
    try {
      return operation()
    } finally {
      active = previousActive
      cursor = previousCursor
    }
  }

  const react = {
    createElement(type, props, ...children) {
      const next = Object.assign({}, props)
      if (children.length === 1) next.children = children[0]
      else if (children.length > 1) next.children = children
      return { type, props: next }
    },
    useState(initial) {
      // Capture THIS component's slot array: the setter may be called later,
      // from an effect, after `active` has been restored to another component.
      const slots = active
      const at = cursor
      cursor += 1
      if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial
      return [slots[at], (value) => {
        slots[at] = typeof value === 'function' ? value(slots[at]) : value
      }]
    },
    useMemo(factory) { return factory() },
    useEffect(effect) { effects.push(effect) },
    useRef(initial) {
      const at = cursor
      cursor += 1
      if (!(at in active)) active[at] = { current: initial }
      return active[at]
    },
    useCallback(fn) { return fn },
  }

  /** Invoke one function component with its own hook window. */
  function invoke(element) {
    return runWith(element.type, element.props && element.props.key, () => element.type(element.props || {}))
  }

  function flatten(element) {
    if (element === null || element === undefined || element === false) return ''
    if (typeof element === 'string' || typeof element === 'number') return String(element)
    if (Array.isArray(element)) return element.map(flatten).join('')
    if (typeof element.type === 'function') return flatten(invoke(element))
    return flatten(element.props === undefined ? undefined : element.props.children)
  }

  return {
    react,
    invokeElement: invoke,
    /** Render a component instance to plain text (its own hook window). */
    paint(component, props) {
      return runWith(component, undefined, () => flatten(component(props)))
    },
    /** Run the effects queued by the last paints; returns a dispose fn. */
    flush() {
      const pending = effects.splice(0)
      const cleanups = pending.map((effect) => effect()).filter((d) => typeof d === 'function')
      return () => { for (const dispose of cleanups) dispose() }
    },
    /** Drop every hook slot: the next paint is a fresh mount (module state stays). */
    resetInstances() {
      slotsByComponent.clear()
      effects.length = 0
      active = []
      cursor = 0
    },
    pending() { return effects.length },
  }
}

// ─────────────────── bundle loading (real file) ───────────────────
const registrations = []
globalThis.window = { __ModuleLoader__: { load: (reg) => { registrations.push(reg) } } }
new Function('window', readFileSync(BUNDLE, 'utf8'))(globalThis.window)

const failures = []
function check(name, fn) {
  try {
    fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures.push(`${name}: ${error && error.message}`)
    console.log(`  FAIL ${name}: ${error && error.message}`)
  }
}

check('bundle registers once under dsh-live-run', () => {
  if (registrations.length !== 1) throw new Error(`registrations=${registrations.length}`)
  if (registrations[0].id !== 'dsh-live-run') throw new Error('id=' + registrations[0].id)
})

const reg = registrations[0]
/** Each factory call gets its own runtime, so mounts never share hook slots. */
const requireFor = (runtime) => (spec) => {
  if (spec === 'react') return runtime.react
  throw new Error('undeclared module request: ' + spec)
}

// ─────────────────────────── fake runtime ───────────────────────────
function makeCtx(options) {
  const opt = options || {}
  const holder = { descriptor: undefined }
  const ctx = {
    get: (name) => {
      if (name === 'uiSession') return opt.uiSession
      if (name === 'jobs') return opt.jobs
      return undefined
    },
    logger: { warn: () => {}, error: () => {}, log: () => {} },
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    inject: (names, cb) => {
      if (names.indexOf('betterSidebar') === -1) return
      cb({
        get: (name) => (name === 'betterSidebar'
          ? { registerTab: (descriptor) => { holder.descriptor = descriptor; return () => {} } }
          : undefined),
        logger: ctx.logger,
        effect: ctx.effect,
        inject: ctx.inject,
      })
    },
  }
  return { ctx, holder }
}

function makeConversation(nodes, running) {
  const data = { nodes: nodes, running: running || [] }
  const listeners = new Set()
  return {
    getSnapshot: () => ({
      views: {
        get: (key) => (key === 'chat' ? { legacy: { nodes: data.nodes, runningCalls: data.running } } : undefined),
        grouped: () => undefined,
      },
      activeTargets: new Set(),
    }),
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    publish(nodesNext, runningNext) {
      data.nodes = nodesNext
      data.running = runningNext || []
      for (const listener of listeners) listener()
    },
  }
}

function makeJobs(rows, observed) {
  return {
    state: {
      getSnapshot: () => ({ rows: rows, observed: observed }),
      subscribe: () => () => {},
    },
    watchRows: () => () => {},
    observe: () => () => {},
    kill: async () => {},
  }
}

/** A jobs service whose roster/observations can change between paints. */
function makeMutableJobs(rows, observed) {
  const state = { rows: rows, observed: observed }
  return {
    get rows() { return state.rows },
    set rows(next) { state.rows = next },
    get observed() { return state.observed },
    set observed(next) { state.observed = next },
    service: {
      state: {
        getSnapshot: () => ({ rows: state.rows, observed: state.observed }),
        subscribe: () => () => {},
      },
      watchRows: () => () => {},
      observe: () => () => {},
      kill: async () => {},
    },
  }
}

function makeBinding(sessionId, conversation) {
  return {
    adapter: {
      current: {
        getSnapshot: () => ({ key: sessionId, hooks: { conversation: conversation } }),
        subscribe: () => () => {},
      },
    },
  }
}

function nodeOf(callId, name, args, resultText, opts) {
  const o = opts || {}
  const time = o.time !== undefined ? o.time : 1000
  return {
    kind: 'tool-result',
    callId,
    time,
    callTime: o.callTime !== undefined ? o.callTime : time,
    isError: o.isError === true,
    subCalls: o.subCalls || [],
    call: { name, argsRaw: typeof args === 'string' ? args : JSON.stringify(args) },
    content: resultText === undefined ? [] : [{ type: 'text', text: resultText }],
  }
}

/**
 * Bind one plugin + runtime to a fresh sidebar environment and session scope.
 * The plugin must keep the SAME factory runtime across remounts: in the page the
 * module (and its `React` + its module-level stores) is memoized, only the
 * component tree unmounts.
 */
function mountWith(plugin, runtime, options) {
  const env = makeCtx(options.ctxOptions)
  plugin.apply(env.ctx)
  const descriptor = env.holder.descriptor
  const props = {
    ctx: env.ctx,
    scope: { sessionId: options.sessionId || 'session-x', cwd: options.cwd || 'E:/work' },
    visible: true,
    store: options.store,
    tab: { id: 't1', type: 'dsh-live-run:pane' },
  }
  return {
    plugin,
    descriptor,
    props,
    runtime,
    paint() { return runtime.paint(descriptor.component, props) },
    flush() { runtime.flush() },
    /** Paint, run the effects that paint queued, then paint again. */
    settle() {
      this.paint()
      this.flush()
      return this.paint()
    },
  }
}

/** One mounted tab: own runtime, own descriptor, repeated paints keep hook state. */
function mountTab(pluginOrFactory, options) {
  const runtime = createRuntime()
  // A plugin object has its own `apply`; a factory is a function (which also
  // owns Function.prototype.apply, hence the object check).
  const plugin = pluginOrFactory !== null && typeof pluginOrFactory === 'object'
    && typeof pluginOrFactory.apply === 'function'
    ? pluginOrFactory
    : pluginOrFactory(requireFor(runtime))
  return mountWith(plugin, runtime, options)
}

/**
 * Unmount and mount again inside the SAME factory runtime: hook slots are
 * dropped (a real remount), module-level state and the plugin's `React` binding
 * survive. This is what "关掉再开" looks like to the page.
 */
function remountTab(previous, options) {
  previous.runtime.resetInstances()
  return mountWith(previous.plugin, previous.runtime, options)
}

// ───────────────────────── 1. plugin surface ─────────────────────────
console.log('\n[1] plugin surface + tab registration')
const probeRuntime = createRuntime()
const probePlugin = reg.factory(requireFor(probeRuntime))
check('exports name/inject/apply', () => {
  if (probePlugin.name !== 'dsh-live-run') throw new Error('name=' + probePlugin.name)
  if (!Array.isArray(probePlugin.inject)) throw new Error('inject is not an array')
  if (typeof probePlugin.apply !== 'function') throw new Error('no apply')
})
const probeEnv = makeCtx()
probePlugin.apply(probeEnv.ctx)
const descriptor = probeEnv.holder.descriptor
check('registers one single-instance tab', () => {
  if (descriptor === undefined) throw new Error('no tab registered')
  if (descriptor.id !== 'dsh-live-run:pane') throw new Error('id=' + descriptor.id)
  if (descriptor.single !== true) throw new Error('not single')
  if (typeof descriptor.component !== 'function') throw new Error('no component')
  if (descriptor.title !== '实时运行') throw new Error('title=' + descriptor.title)
})
check('survives an absent betterSidebar service', () => {
  probePlugin.apply({
    get: () => undefined,
    logger: { warn: () => {}, error: () => {} },
    effect: (fn) => { fn() },
    inject: (names, cb) => {
      if (names.indexOf('betterSidebar') !== -1) {
        cb({ get: () => undefined, logger: { warn: () => {} }, effect: (fn) => { fn() } })
      }
    },
  })
})

// ───────────────────── 2. mount: no binding ─────────────────────
console.log('\n[2] mount with no session binding')
check('renders empty states without throwing', () => {
  const tab = mountTab(reg.factory, {})
  const text = tab.settle()
  if (!text.includes('当前文件')) throw new Error('no file pane')
  if (!text.includes('等待文件操作')) throw new Error('no empty file hint')
  if (!text.includes('写入过程')) throw new Error('no ops pane')
  if (!text.includes('命令输出')) throw new Error('no jobs pane')
  if (!text.includes('未连接到本会话')) throw new Error('no disconnected notice')
  if (!text.includes('本部署没有发布')) throw new Error('no jobs-service notice')
})

// ────────────── 3. mount: live snapshot + job ──────────────
console.log('\n[3] mount with a live snapshot and a running job')
const nodes = [
  nodeOf('c1', 'read', { file_path: 'E:/work/src/a.ts' }, 'line1\nline2\n(Showing lines 1-2 of 2)', { time: 900 }),
  nodeOf('c2', 'write', { file_path: 'E:/work/src/b.ts', content: 'export const b = 1\n' }, undefined, { time: 1000 }),
  nodeOf('c3', 'edit', { file_path: 'E:/work/src/b.ts', old_string: 'const c = 2', new_string: 'const c = 3' }, 'ok', { time: 1100 }),
]
const conversation = makeConversation(nodes, [])
const jobs = makeJobs(
  { 'session-x': [{ id: 'pwsh-abc', kind: 'pwsh', label: 'npm run build', owner: 'session-x', status: 'running', startedAt: Date.now() - 5000 }] },
  { 'pwsh-abc': { text: '$ npm run build\nsrc/b.ts 12:3 - error TS2322\n', gapBefore: false, streaming: true } },
)
const live = mountTab(reg.factory, {
  ctxOptions: { uiSession: makeBinding('session-x', conversation), jobs: jobs },
})

check('renders current file, diff, op list and live output', () => {
  const text = live.settle()
  if (!text.includes('src/b.ts')) throw new Error('current file path missing')
  if (!text.includes('const c = 3')) throw new Error('edit payload not rendered')
  if (!text.includes('const c = 2')) throw new Error('edit old side not rendered')
  if (!text.includes('写入过程')) throw new Error('no ops pane')
  if (!text.includes('npm run build')) throw new Error('job label missing')
  if (!text.includes('error TS2322')) throw new Error('live job text missing')
  if (!text.includes('运行中')) throw new Error('running badge missing')
  if (!text.includes('跟随最新')) throw new Error('follow badge missing')
})

// ───────────────────── 4. reactivity on delta ─────────────────────
console.log('\n[4] repaint on published data')
let next = nodes
check('a new write is followed', () => {
  next = nodes.concat([nodeOf('c4', 'write', { file_path: 'E:/work/src/late.ts', content: 'export const late = true\n' }, undefined, { time: 2000 })])
  conversation.publish(next, [])
  const text = live.paint()
  if (!text.includes('src/late.ts')) throw new Error('new file not followed')
  if (!text.includes('const late = true')) throw new Error('new content not shown')
})
check('a running call is listed as in progress', () => {
  conversation.publish(next, [{ callId: 'r9', name: 'write', argsRaw: JSON.stringify({ path: 'E:/work/src/pending.ts', content: 'partial' }), time: 3000, subCalls: [] }])
  const text = live.paint()
  if (!text.includes('pending.ts')) throw new Error('running write not listed')
  if (!text.includes('文件操作进行中')) throw new Error('running counter missing')
})

// ───────────────────── 5. extraction logic ─────────────────────
console.log('\n[5] op extraction')
const internals = live.plugin.__internals
check('__internals exported', () => {
  if (internals === undefined || typeof internals.extractOps !== 'function') throw new Error('missing internals')
})
check('read/write/edit, newest first', () => {
  const ops = internals.extractOps(nodes, [])
  if (ops.length !== 3) throw new Error('ops=' + ops.length)
  if (ops[0].kind !== 'edit') throw new Error('order=' + ops[0].kind)
  const write = ops.find((op) => op.kind === 'write')
  if (write === undefined || !/export const b/.test(write.content)) throw new Error('write payload lost')
})
check('edit diff payload', () => {
  const edit = internals.extractOps(nodes, []).find((op) => op.kind === 'edit')
  if (edit.edit.oldString !== 'const c = 2' || edit.edit.newString !== 'const c = 3') throw new Error('diff payload wrong')
})
check('read text + partial marker', () => {
  const read = internals.extractOps(nodes, []).find((op) => op.kind === 'read')
  if (!/Showing lines/.test(read.read || '')) throw new Error('read text lost')
})
check('present expands per file', () => {
  const ops = internals.extractOps([nodeOf('p1', 'present', { files: [{ path: 'E:/w/a.png' }, { path: 'E:/w/b.png' }] }, undefined)], [])
  if (ops.length !== 2) throw new Error('ops=' + ops.length)
  if (ops[0].presentOnly !== true) throw new Error('not marked presentOnly')
})
check('shell payload fs calls become ops', () => {
  const ops = internals.extractOps([nodeOf('s1', 'pwsh', { command: "Set-Content -Path 'E:/w/c.txt' -Value hi" }, '')], [])
  if (ops.length !== 1) throw new Error('ops=' + ops.length)
  if (ops[0].kind !== 'write' || ops[0].viaCode !== true) throw new Error('wrong op')
})
check('failed op is an error payload, not content', () => {
  const payload = internals.payloadOf(internals.extractOps([nodeOf('f1', 'read', { file_path: 'E:/w/x.ts' }, 'offset 1597 out of range', { isError: true })], []))
  if (payload.kind !== 'error') throw new Error('kind=' + payload.kind)
})
check('payload prefers the newest payload-bearing op', () => {
  const payload = internals.payloadOf(internals.extractOps(nodes, []))
  if (payload.kind !== 'diff') throw new Error('kind=' + payload.kind)
})
check('subCalls are walked', () => {
  const parent = nodeOf('q1', 'run_code', { code: 'x' }, 'done', {
    subCalls: [nodeOf('q1:1', 'write', { file_path: 'E:/w/d.ts', content: 'y' }, undefined)],
  })
  const ops = internals.extractOps([parent], [])
  if (ops.length !== 1) throw new Error('ops=' + ops.length)
})
check('relPath inside cwd', () => {
  if (internals.relPath('E:/work/src/a.ts', 'E:/work') !== 'src/a.ts') throw new Error('inside failed')
  if (internals.relPath('D:/other/a.ts', 'E:/work') !== 'D:/other/a.ts') throw new Error('outside failed')
})
check('lineDelta on edit', () => {
  if (internals.lineDelta({ kind: 'edit', edit: { oldString: 'a', newString: 'a\nb' } }) !== 1) throw new Error('delta wrong')
})

// ───────────── 5b. command-output fallbacks ─────────────
console.log('\n[5b] command output after a foreground job is removed')
check('extractShell keeps settled shell calls', () => {
  const shellNodes = [nodeOf('sh1', 'pwsh', { command: 'npm test' }, 'PASS 12 tests\n', { time: 1500 })]
  const entries = internals.extractShell(shellNodes, [])
  if (entries.length !== 1) throw new Error('entries=' + entries.length)
  if (entries[0].command !== 'npm test') throw new Error('command lost')
  if (!/PASS 12 tests/.test(entries[0].output)) throw new Error('output lost')
})
check('without a jobs service the pane falls back to the conversation log', () => {
  const shellNodes = [nodeOf('sh2', 'pwsh', { command: 'npm test' }, 'PASS 12 tests\n', { time: 1500 })]
  const tab = mountTab(reg.factory, {
    ctxOptions: { uiSession: makeBinding('session-x', makeConversation(shellNodes, [])) },
  })
  const text = tab.settle()
  if (!text.includes('PASS 12 tests')) throw new Error('settled shell output missing')
  if (!text.includes('会话记录')) throw new Error('history label missing')
})
check('a removed job keeps its last observation on screen', () => {
  const shellNodes = [nodeOf('sh3', 'pwsh', { command: 'npm run dev' }, '', { time: 1500 })]
  const mutable = makeMutableJobs(
    { 'session-x': [{ id: 'pwsh-dev', kind: 'pwsh', label: 'npm run dev', owner: 'session-x', status: 'running', startedAt: Date.now() - 2000 }] },
    { 'pwsh-dev': { text: 'vite v6 ready in 431 ms\nLocal: http://localhost:5173/\n', gapBefore: false, streaming: true } },
  )
  const tab = mountTab(reg.factory, {
    ctxOptions: { uiSession: makeBinding('session-x', makeConversation(shellNodes, [])), jobs: mutable.service },
  })
  for (let i = 0; i < 3; i += 1) { tab.paint(); tab.flush() }
  const live = tab.paint()
  if (!live.includes('localhost:5173')) throw new Error('live output missing')
  if (!live.includes('运行中')) throw new Error('running badge missing')
  // The foreground call settles: the registry drops the record.
  mutable.rows = {}
  mutable.observed = {}
  for (let i = 0; i < 3; i += 1) { tab.paint(); tab.flush() }
  const after = tab.paint()
  if (!after.includes('localhost:5173')) throw new Error('last observation dropped with the job')
  if (!after.includes('已结束')) throw new Error('settled badge missing')
})

// ───────────── 5c. long command: wrap + collapse ─────────────
console.log('\n[5c] a long command wraps, collapses, and cannot squeeze the title')
const LONG = "$script = @'\necho \"=== 功能验证 1: 狗上新建 shell 无报错 ===\"\nssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null root@10.0.0.2 'echo hi'\n'@\n& $script"

/** Depth-first walk that resolves function components, so tests can inspect leaves. */
function walkElements(rt, element, visit) {
  if (element === null || element === undefined || element === false) return
  if (Array.isArray(element)) { for (const child of element) walkElements(rt, child, visit); return }
  if (typeof element === 'string' || typeof element === 'number') return
  if (typeof element.type === 'function') { walkElements(rt, rt.invokeElement(element), visit); return }
  visit(element)
  walkElements(rt, element.props === undefined ? undefined : element.props.children, visit)
}

function findButton(rt, tree, label) {
  let found
  walkElements(rt, tree, (el) => {
    if (found !== undefined) return
    if (el.type === 'button' && el.props.children === label) found = el
  })
  return found
}

/** The command block's code cell (the pre-wrap/pre node holding the command). */
function findCommandCell(rt, tree) {
  let found
  walkElements(rt, tree, (el) => {
    if (found !== undefined) return
    if (el.type !== 'div') return
    const style = el.props.style
    if (style === undefined || style.fontFamily !== MONO_FOR_TEST) return
    if (typeof style.whiteSpace !== 'string') return
    found = el
  })
  return found
}
const MONO_FOR_TEST = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Cascadia Mono", monospace'

const longJobs = makeJobs(
  { 'session-x': [{ id: 'pwsh-long', kind: 'pwsh', label: LONG, owner: 'session-x', status: 'running', startedAt: Date.now() - 3000 }] },
  { 'pwsh-long': { text: '=== 功能验证 1 ===\nok\n', gapBefore: false, streaming: true } },
)
const longTab = mountTab(reg.factory, {
  ctxOptions: { uiSession: makeBinding('session-x', makeConversation([], [])), jobs: longJobs },
})
let longTree = null
check('header keeps a short first line, title is not squeezed', () => {
  longTab.settle()
  longTree = longTab.descriptor.component(longTab.props)
  let title = null
  walkElements(longTab.runtime, longTree, (el) => {
    if (el.type === 'span' && el.props.children === '命令输出') title = el
  })
  if (title === null) throw new Error('section title missing')
  if (title.props.style.flex !== 'none') throw new Error('title can shrink: flex=' + title.props.style.flex)
  if (title.props.style.whiteSpace !== 'nowrap') throw new Error('title may wrap')
  const text = longTab.paint()
  if (!text.includes('$script = @')) throw new Error('short first line missing from header')
  if (!text.includes('展开')) throw new Error('no 展开 control for a long command')
  if (!text.includes('复制')) throw new Error('no 复制 control')
  // The header slot must carry a ONE-LINE, capped form — the full multi-line
  // command lives in the collapsible block below it.
  let extra = null
  walkElements(longTab.runtime, longTab.descriptor.component(longTab.props), (el) => {
    if (extra !== null || el.type !== 'span') return
    const style = el.props.style
    if (style === undefined || style.textOverflow !== 'ellipsis' || style.whiteSpace !== 'nowrap') return
    if (typeof el.props.children !== 'string' || !el.props.children.includes('$script')) return
    extra = el
  })
  if (extra === null) throw new Error('header extra span missing')
  if (extra.props.children.includes('\n')) throw new Error('header carried the multi-line command')
  if (extra.props.children.length > 60) throw new Error('header form too long: ' + extra.props.children.length)
})
check('collapsed cell is one line, expanded wraps', () => {
  const collapsed = findCommandCell(longTab.runtime, longTree)
  if (collapsed === undefined) throw new Error('command cell missing')
  if (collapsed.props.style.whiteSpace !== 'pre') throw new Error('collapsed whiteSpace=' + collapsed.props.style.whiteSpace)
  if (collapsed.props.style.maxHeight !== 16) throw new Error('collapsed not clipped to one line')
  const expand = findButton(longTab.runtime, longTree, '展开')
  if (expand === undefined) throw new Error('展开 button not found')
  expand.props.onClick()
  const expandedTree = longTab.descriptor.component(longTab.props)
  const expanded = findCommandCell(longTab.runtime, expandedTree)
  if (expanded === undefined) throw new Error('command cell missing after expand')
  if (expanded.props.style.whiteSpace !== 'pre-wrap') throw new Error('expanded whiteSpace=' + expanded.props.style.whiteSpace)
  if (expanded.props.style.maxHeight !== 132) throw new Error('expanded maxHeight=' + expanded.props.style.maxHeight)
  if (findButton(longTab.runtime, expandedTree, '折叠') === undefined) throw new Error('no 折叠 after expand')
  if (findButton(longTab.runtime, expandedTree, '展开') !== undefined) throw new Error('展开 still shown after expand')
})

// ───────────── 5d. expansion memory (per session, per command) ─────────────
console.log('\n[5d] 展开/折叠 state survives switching commands and remounting')
const CMD_A = `AAA-command ${'x'.repeat(70)}`
const CMD_B = `BBB-command ${'y'.repeat(70)}`
const jobRows = [
  { id: 'j-a', kind: 'pwsh', label: CMD_A, owner: 'session-x', status: 'running', startedAt: Date.now() - 1000 },
  { id: 'j-b', kind: 'pwsh', label: CMD_B, owner: 'session-x', status: 'running', startedAt: Date.now() - 500 },
]
const twoJobs = makeJobs(
  // The roster is keyed by WATCHED session; mirror it so session-z also has a
  // command to look at (otherwise "different session" has nothing to collapse).
  { 'session-x': jobRows, 'session-z': jobRows },
  {
    'j-a': { text: 'A-OUT\n', gapBefore: false, streaming: true },
    'j-b': { text: 'B-OUT\n', gapBefore: false, streaming: true },
  },
)
const memoryTab = mountTab(reg.factory, {
  sessionId: 'session-x',
  ctxOptions: { uiSession: makeBinding('session-x', makeConversation([], [])), jobs: twoJobs },
})

function findByTitle(rt, tree, title) {
  let found
  walkElements(rt, tree, (el) => {
    if (found !== undefined) return
    if (el.props !== undefined && el.props.title === title && typeof el.props.onClick === 'function') found = el
  })
  return found
}

function toggleState(tab) {
  const tree = tab.descriptor.component(tab.props)
  if (findButton(tab.runtime, tree, '折叠') !== undefined) return 'expanded'
  if (findButton(tab.runtime, tree, '展开') !== undefined) return 'collapsed'
  return 'none'
}

check('default is collapsed, expanding reports the choice', () => {
  memoryTab.settle()
  if (toggleState(memoryTab) !== 'collapsed') throw new Error('default is not collapsed')
  const expand = findButton(memoryTab.runtime, memoryTab.descriptor.component(memoryTab.props), '展开')
  expand.props.onClick()
  memoryTab.paint()
  if (toggleState(memoryTab) !== 'expanded') throw new Error('expand did not apply')
})
check('the toggle reached the session store', () => {
  const store = memoryTab.plugin.__internals.expansionOf('session-x', 'job:j-a')
  if (store !== true) throw new Error('store did not record job:j-a (got ' + store + ')')
})
check('switching to another command does not carry the state over', () => {
  const chipB = findByTitle(memoryTab.runtime, memoryTab.descriptor.component(memoryTab.props), CMD_B)
  if (chipB === undefined) throw new Error('job B chip missing')
  chipB.props.onClick()
  memoryTab.paint()
  if (toggleState(memoryTab) !== 'collapsed') throw new Error('command B inherited command A expansion')
  const text = memoryTab.paint()
  if (!text.includes('B-OUT')) throw new Error('command B not selected')
})
check('switching back restores the remembered state', () => {
  const chipA = findByTitle(memoryTab.runtime, memoryTab.descriptor.component(memoryTab.props), CMD_A)
  if (chipA === undefined) throw new Error('job A chip missing')
  chipA.props.onClick()
  memoryTab.paint()
  if (toggleState(memoryTab) !== 'expanded') throw new Error('command A forgot its expansion')
})
check('a remount in the same session still remembers', () => {
  const remount = remountTab(memoryTab, {
    sessionId: 'session-x',
    ctxOptions: { uiSession: makeBinding('session-x', makeConversation([], [])), jobs: twoJobs },
  })
  remount.settle()
  if (toggleState(remount) !== 'expanded') throw new Error('remount lost the expansion')
})
check('a different session starts collapsed', () => {
  const other = remountTab(memoryTab, {
    sessionId: 'session-z',
    ctxOptions: { uiSession: makeBinding('session-z', makeConversation([], [])), jobs: twoJobs },
  })
  other.settle()
  if (toggleState(other) !== 'collapsed') throw new Error('another session inherited the expansion')
})

// ───────────── 5e. plugin settings: memory switch + one-line copy ─────────────
console.log('\n[5e] plugin settings (侧边卡 rows) and the copy modes')

/** A live side-card store: prefs.pluginSettings['dsh-live-run:pane'] with subscribers. */
function makeStore(initial) {
  const state = {
    prefs: { pluginSettings: { 'dsh-live-run:pane': Object.assign({}, initial) } },
  }
  const listeners = new Set()
  return {
    getSnapshot: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    setBlob(patch) {
      state.prefs = {
        pluginSettings: {
          'dsh-live-run:pane': Object.assign({}, state.prefs.pluginSettings['dsh-live-run:pane'], patch),
        },
      }
      for (const listener of listeners) listener()
    },
    blob: () => state.prefs.pluginSettings['dsh-live-run:pane'],
  }
}

const CMD_MULTI = 'cd C:\\work\nnpm run build'
const CMD_HERE = "$s = @'\nhello\n'@\n& $s"

check('the descriptor declares two plugin-owned switches', () => {
  const settings = probeEnv.holder.descriptor.settings
  if (settings === undefined || !Array.isArray(settings.pluginToggles)) throw new Error('no pluginToggles')
  const rows = settings.pluginToggles
  if (rows.length !== 2) throw new Error('rows=' + rows.length)
  const remember = rows.find((row) => row.key === 'rememberExpansion')
  const copy = rows.find((row) => row.key === 'copyOneLine')
  if (remember === undefined || copy === undefined) throw new Error('missing a row')
  if (remember.type !== 'switch' || remember.defaultValue !== true) throw new Error('remember row wrong')
  if (copy.type !== 'switch' || copy.defaultValue !== false) throw new Error('copy row wrong')
  // A host-prefs `toggles` array would silently drop these keys — must not be used.
  if (settings.toggles !== undefined) throw new Error('declared host-prefs toggles instead')
})

check('readSettings defaults and overrides', () => {
  const internals2 = live.plugin.__internals
  const empty = internals2.readSettings(makeStore({}))
  if (empty.rememberExpansion !== true || empty.copyOneLine !== false) throw new Error('defaults wrong')
  const flipped = internals2.readSettings(makeStore({ rememberExpansion: false, copyOneLine: true }))
  if (flipped.rememberExpansion !== false || flipped.copyOneLine !== true) throw new Error('overrides ignored')
  const absent = internals2.readSettings(undefined)
  if (absent.rememberExpansion !== true) throw new Error('absent store must fall back to defaults')
})

check('one-line transform: decisions match the validated sample table', () => {
  const { toOneLine } = live.plugin.__internals
  const cases = [
    ['cd C:\\work\nnpm run build', 'pwsh', 'joined'],
    ['Get-ChildItem |\n  Select-Object Name', 'pwsh', 'joined'],
    ['$x =\n  5', 'pwsh', 'joined'],
    ["$s = @'\nhello\n'@\n& $s", 'pwsh', 'refuse'],
    ['Get-ChildItem # list\nRemove-Item x', 'pwsh', 'refuse'],
    ['$m = "a\nb"', 'pwsh', 'refuse'],
    ['Get-Date', 'pwsh', 'as-is'],
    ['cat <<EOF\nhi\nEOF', 'bash', 'refuse'],
    ['echo a \\\n  b', 'bash', 'joined'],
  ]
  for (const [text, kind, expected] of cases) {
    const result = toOneLine(text, kind)
    if (result.kind !== expected) {
      throw new Error(`${JSON.stringify(text.slice(0, 24))} (${kind}) → ${result.kind}, expected ${expected}`)
    }
  }
})

check('copyPayload keeps the original when the mode is off or unsafe', () => {
  const { copyPayload } = live.plugin.__internals
  const raw = copyPayload(CMD_MULTI, 'pwsh', false)
  if (raw.text !== CMD_MULTI || raw.notice !== '') throw new Error('raw mode altered the command')
  const oneLine = copyPayload(CMD_MULTI, 'pwsh', true)
  if (oneLine.text !== 'cd C:\\work; npm run build') throw new Error('line=' + oneLine.text)
  if (oneLine.notice !== '已折成一行') throw new Error('notice=' + oneLine.notice)
  const refused = copyPayload(CMD_HERE, 'pwsh', true)
  if (refused.text !== CMD_HERE) throw new Error('refused copy must stay verbatim')
  if (!/here-string/.test(refused.notice)) throw new Error('reason missing: ' + refused.notice)
})

check('the copy button writes what the mode says', () => {
  const captured = []
  memoryTab.plugin.__internals.setClipboardWriter((text) => { captured.push(text); return true })
  const store = makeStore({ copyOneLine: false })
  // Same factory runtime as the plugin: a fresh runtime would swap the React
  // binding the plugin closed over (see remountTab).
  const tab = remountTab(memoryTab, {
    sessionId: 'session-x',
    store: store,
    ctxOptions: { uiSession: makeBinding('session-x', makeConversation([], [])), jobs: twoJobs },
  })
  tab.settle()
  const rawButton = findButton(tab.runtime, tab.descriptor.component(tab.props), '复制')
  if (rawButton === undefined) throw new Error('raw copy button missing')
  rawButton.props.onClick()
  const first = captured[captured.length - 1]
  if (first !== CMD_A) throw new Error('raw copy wrote the wrong text: ' + JSON.stringify(first))

  store.setBlob({ copyOneLine: true })
  tab.settle()
  const lineButton = findButton(tab.runtime, tab.descriptor.component(tab.props), '复制一行')
  if (lineButton === undefined) throw new Error('one-line copy button missing after the flip')
  lineButton.props.onClick()
  const second = captured[captured.length - 1]
  const expected = memoryTab.plugin.__internals.copyPayload(CMD_A, 'pwsh', true).text
  if (second !== expected) throw new Error('one-line copy wrote the wrong text')
})

check('turning the memory switch off forgets and stops recording', () => {
  const store = makeStore({ rememberExpansion: true })
  const plugin = live.plugin
  const tab = remountTab(live, {
    sessionId: 'session-x',
    store: store,
    ctxOptions: { uiSession: makeBinding('session-x', makeConversation([], [])), jobs: twoJobs },
  })
  tab.settle()
  const internals2 = plugin.__internals
  // Expand via the UI: the memory must record it while the switch is on.
  const expand = findButton(tab.runtime, tab.descriptor.component(tab.props), '展开')
  expand.props.onClick()
  tab.flush()
  if (internals2.expansionOf('session-x', 'job:j-a') !== true) throw new Error('switch on but nothing recorded')
  // Flip it off: the stored state is dropped and nothing new is written.
  store.setBlob({ rememberExpansion: false })
  tab.settle()
  if (internals2.expansionOf('session-x', 'job:j-a') !== false) throw new Error('switch off did not forget')
  const expandAgain = findButton(tab.runtime, tab.descriptor.component(tab.props), '展开')
  if (expandAgain === undefined) throw new Error('stored state still seeded after the purge')
  expandAgain.props.onClick()
  tab.flush()
  if (internals2.expansionOf('session-x', 'job:j-a') !== false) throw new Error('switch off still records')
})

// ───────────────────── 6. reload path ─────────────────────
console.log('\n[6] second factory execution (HMR)')
check('a second execution registers a working tab', () => {
  const tab = mountTab(reg.factory, {})
  if (tab.plugin.name !== 'dsh-live-run') throw new Error('broken second execution')
  if (tab.descriptor === undefined) throw new Error('no tab on second execution')
  const text = tab.settle()
  if (!text.includes('当前文件')) throw new Error('second mount does not render')
})

console.log('')
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed:`)
  for (const failure of failures) console.error(' - ' + failure)
  process.exit(1)
}
clearTimeout(WATCHDOG)
console.log(`all checks passed — ${BUNDLE}`)
// The mini runtime never unmounts, so interval effects from useTick would keep
// the event loop alive; the real React cleanup path handles that in the page.
process.exit(0)
