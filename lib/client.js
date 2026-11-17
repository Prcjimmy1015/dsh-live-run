/**
 * dsh-live-run — browser half.
 *
 * One sidebar tab that answers, while a task is running:
 *   1. 当前文件      — the file the model is touching right now, with content/diff
 *   2. 写入过程      — every read/write/edit op with kind, time and line delta
 *   3. 命令输出      — live stdout of the running job (registry ring, tailed)
 *
 * Data comes exclusively from services this deployment already publishes:
 *   - `uiSession` binding → `hooks.conversation` (the Chat view snapshot:
 *     tool calls + results, including RUNNING calls),
 *   - `ctx.jobs` (the client jobs service: roster per session + retained
 *     output streams, read through `observe()`),
 *   - `betterSidebar.registerTab` (the sidebar the user actually sees).
 *
 * Written as a plain CJS factory bundle: no JSX, no build step. `react` is a
 * platform seed word of the page module table.
 */
window.__ModuleLoader__.load({
  id: 'dsh-live-run',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    // ───────────────────────────── theme ─────────────────────────────
    var C = {
      bg: 'var(--dsw-alias-bg-layer-1, #1b1c1f)',
      bg2: 'var(--dsw-alias-bg-layer-2, #232427)',
      base: 'var(--dsw-alias-bg-base, #141517)',
      border: 'var(--dsw-alias-border-l1, rgba(128,128,128,.26))',
      border2: 'var(--dsw-alias-border-l2, rgba(128,128,128,.45))',
      text: 'var(--dsw-alias-label-primary, #e6e6e6)',
      dim: 'var(--dsw-alias-label-secondary, #9aa0a6)',
      brand: 'var(--dsw-alias-brand-primary, #4c8dff)',
      ok: 'var(--dsw-alias-state-success-primary, #2ea043)',
      err: 'var(--dsw-alias-state-error-primary, #e5534b)',
      warn: 'var(--dsw-alias-state-warn-primary, #d29922)',
    }
    var MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Cascadia Mono", monospace'
    var SANS = 'inherit'

    // ───────────────────── tool classification ─────────────────────
    var READ_TOOLS = { read: 1, view: 1, see: 1 }
    var WRITE_TOOLS = { write: 1, create: 1 }
    var EDIT_TOOLS = { edit: 1, str_replace: 1, 'str-replace-editor': 1, 'multi-edit': 1 }
    var SHELL_TOOLS = {
      pwsh: 1, bash: 1, shell: 1, execute_code: 1, run_code: 1, python: 1, terminal: 1,
    }

    var CODE_READ_RE = /(?:readFileSync|readFile|openSync|createReadStream)\s*\(\s*['"]([^'"]{2,}?)['"](?!\s*\+)/g
    var CODE_WRITE_RE = /(?:writeFileSync|writeFile|createWriteStream|appendFileSync|rmSync|unlinkSync|mkdirSync|copyFileSync|renameSync)\s*\(\s*['"]([^'"]{2,}?)['"](?!\s*\+)/g
    var PS_READ_RE = /(?:Get-Content|gc|cat)\s+(?:-Path\s+)?['"]([^'"\r\n|;]{2,}?)['"]/g
    var PS_WRITE_RE = /(?:Set-Content|sc|Out-File|Add-Content)\s+(?:-Path\s+)?['"]([^'"\r\n|;]{2,}?)['"]/g

    function parseArgs(raw) {
      if (typeof raw !== 'string' || raw.length === 0) return {}
      try {
        var v = JSON.parse(raw)
        return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : {}
      } catch (e) {
        return {}
      }
    }

    function pathOf(args) {
      var keys = ['file_path', 'path', 'filePath', 'target_file']
      for (var i = 0; i < keys.length; i++) {
        var v = args[keys[i]]
        if (typeof v === 'string' && v.length > 0) return v
      }
      return undefined
    }

    function kindOf(name) {
      if (READ_TOOLS[name] === 1) return 'read'
      if (WRITE_TOOLS[name] === 1) return 'write'
      if (EDIT_TOOLS[name] === 1) return 'edit'
      return undefined
    }

    function joinText(content) {
      if (!Array.isArray(content)) return ''
      var out = ''
      for (var i = 0; i < content.length; i++) {
        var block = content[i]
        if (block !== null && typeof block === 'object' && typeof block.text === 'string') out += block.text
      }
      return out
    }

    /** Synthetic ops for direct fs calls / PowerShell file cmdlets inside a shell payload. */
    function codeOpsOf(argsRaw, callId, time, isError) {
      var args = parseArgs(argsRaw)
      var parts = []
      var fields = ['code', 'command', 'script', 'body']
      for (var i = 0; i < fields.length; i++) {
        var v = args[fields[i]]
        if (typeof v === 'string' && v.length > 0) parts.push(v)
      }
      if (parts.length === 0) return []
      var text = parts.join('\n')
      var out = []
      var seen = {}
      function push(path, kind, tag) {
        if (/^(https?:|node:|data:)/.test(path) || path.charAt(0) === '-') return
        if (/[\\/]$/.test(path)) return
        if (!/^([a-z]:[\\/]|\\\\|\/|\.{1,2}\/)/i.test(path)) return
        var key = kind + ':' + path
        if (seen[key] === 1) return
        seen[key] = 1
        out.push({
          id: callId + ':' + tag + ':' + out.length,
          kind: kind,
          path: path,
          time: time,
          running: false,
          isError: isError,
          viaCode: true,
        })
      }
      var pairs = [[CODE_READ_RE, 'read', 'cr'], [PS_READ_RE, 'read', 'pr'], [CODE_WRITE_RE, 'write', 'cw'], [PS_WRITE_RE, 'write', 'pw']]
      for (var p = 0; p < pairs.length; p++) {
        var re = pairs[p][0]
        var kind = pairs[p][1]
        var tag = pairs[p][2]
        re.lastIndex = 0
        var m
        while ((m = re.exec(text)) !== null) push(m[1].trim(), kind, tag)
      }
      return out
    }

    /** Per-block cache: a stable tool-result node is parsed once, not per delta. */
    var ownCache = new WeakMap()

    function ownOps(block) {
      var hit = ownCache.get(block)
      if (hit !== undefined) return hit
      var out = computeOwnOps(block)
      ownCache.set(block, out)
      return out
    }

    function computeOwnOps(block) {
      var isResult = Object.prototype.hasOwnProperty.call(block, 'call')
      var call = isResult ? block.call : block
      if (call === null || call === undefined) return []
      var name = typeof call.name === 'string' ? call.name : ''
      var argsRaw = typeof call.argsRaw === 'string' ? call.argsRaw : ''
      var time = isResult ? (typeof block.callTime === 'number' ? block.callTime : block.time) : block.time
      var callId = block.callId

      if (name === 'present') {
        var pArgs = parseArgs(argsRaw)
        var files = Array.isArray(pArgs.files) ? pArgs.files : []
        var writes = []
        for (var i = 0; i < files.length; i++) {
          var entry = files[i]
          if (entry === null || typeof entry !== 'object') continue
          if (typeof entry.path !== 'string' || entry.path.length === 0) continue
          writes.push({
            id: callId + ':present:' + i,
            kind: 'write',
            path: entry.path,
            time: time,
            running: false,
            isError: isResult ? block.isError === true : false,
            presentOnly: true,
          })
        }
        return writes
      }

      var kind = kindOf(name)
      if (kind !== undefined) {
        var args = parseArgs(argsRaw)
        var path = pathOf(args)
        if (path === undefined) return []
        var op = {
          id: callId,
          kind: kind,
          path: path,
          time: time,
          running: isResult ? false : true,
          isError: isResult ? block.isError === true : false,
        }
        if (isResult && block.isError === true) {
          op.errorText = joinText(block.content)
          return [op]
        }
        if (kind === 'edit') {
          if (typeof args.old_string === 'string' && typeof args.new_string === 'string') {
            op.edit = { oldString: args.old_string, newString: args.new_string }
          }
        } else if (kind === 'write') {
          var fromArgs = typeof args.content === 'string' ? args.content : ''
          var fromResult = isResult ? joinText(block.content) : ''
          var content = fromArgs.length > 0 ? fromArgs : fromResult
          if (content.length > 0) op.content = content
        } else if (kind === 'read' && isResult) {
          var text = joinText(block.content)
          if (text.length > 0) op.read = text
        }
        return [op]
      }

      if (SHELL_TOOLS[name] === 1 && argsRaw.length > 0) {
        return codeOpsOf(
          argsRaw,
          callId,
          time,
          isResult ? block.isError === true : false,
        )
      }
      return []
    }

    /** Fold the Chat view's legacy slice into the flat op list (newest first). */
    function extractOps(nodes, runningCalls) {
      var out = []
      function collect(blocks) {
        for (var i = 0; i < blocks.length; i++) {
          var block = blocks[i]
          if (block === null || typeof block !== 'object') continue
          var own = ownOps(block)
          for (var k = 0; k < own.length; k++) out.push(own[k])
          if (Array.isArray(block.subCalls) && block.subCalls.length > 0) collect(block.subCalls)
        }
      }
      if (Array.isArray(runningCalls)) collect(runningCalls)
      if (Array.isArray(nodes)) {
        for (var i = 0; i < nodes.length; i++) {
          var node = nodes[i]
          if (node === null || typeof node !== 'object') continue
          if (node.kind !== 'tool-result') continue
          collect([node])
        }
      }
      out.sort(function (a, b) { return b.time - a.time })
      return out
    }

    // ── shell history (the fallback the jobs registry cannot keep) ──
    //
    // A FOREGROUND shell call is registered in the jobs registry and then
    // REMOVED once it settles (`jobs.remove` is documented for exactly that
    // caller). So the live pane covers the run, and the settled command's
    // output has to come from the conversation log — which is also the only
    // path on a deployment without the client jobs service.
    var shellCache = new WeakMap()

    function shellOf(block) {
      var hit = shellCache.get(block)
      if (hit !== undefined) return hit
      var out = computeShell(block)
      shellCache.set(block, out)
      return out
    }

    function commandOf(args) {
      var fields = ['command', 'code', 'script', 'cmd']
      for (var i = 0; i < fields.length; i++) {
        var v = args[fields[i]]
        if (typeof v === 'string' && v.length > 0) return v
      }
      return ''
    }

    function computeShell(block) {
      var isResult = Object.prototype.hasOwnProperty.call(block, 'call')
      var call = isResult ? block.call : block
      if (call === null || call === undefined) return []
      var name = typeof call.name === 'string' ? call.name : ''
      if (SHELL_TOOLS[name] !== 1) return []
      var args = parseArgs(typeof call.argsRaw === 'string' ? call.argsRaw : '')
      var command = commandOf(args)
      var time = isResult
        ? (typeof block.callTime === 'number' ? block.callTime : block.time)
        : block.time
      return [{
        id: block.callId,
        name: name,
        command: command,
        time: time,
        running: isResult ? false : true,
        isError: isResult ? block.isError === true : false,
        output: isResult ? joinText(block.content) : '',
      }]
    }

    /** Settled + in-flight shell calls, newest first. */
    function extractShell(nodes, runningCalls) {
      var out = []
      function collect(blocks) {
        for (var i = 0; i < blocks.length; i++) {
          var block = blocks[i]
          if (block === null || typeof block !== 'object') continue
          var own = shellOf(block)
          for (var k = 0; k < own.length; k++) out.push(own[k])
          if (Array.isArray(block.subCalls) && block.subCalls.length > 0) collect(block.subCalls)
        }
      }
      if (Array.isArray(runningCalls)) collect(runningCalls)
      if (Array.isArray(nodes)) {
        for (var i = 0; i < nodes.length; i++) {
          var node = nodes[i]
          if (node === null || typeof node !== 'object') continue
          if (node.kind !== 'tool-result') continue
          collect([node])
        }
      }
      out.sort(function (a, b) { return b.time - a.time })
      return out
    }

    /** The newest payload known for one path (content / diff / read text). */
    function payloadOf(ops) {
      for (var i = 0; i < ops.length; i++) {
        var op = ops[i]
        if (op.errorText !== undefined && op.errorText.length > 0) {
          return { kind: 'error', op: op, text: op.errorText }
        }
        if (op.edit !== undefined) return { kind: 'diff', op: op }
        if (op.content !== undefined) return { kind: 'content', op: op, text: op.content }
        if (op.read !== undefined) return { kind: 'read', op: op, text: op.read }
      }
      return { kind: 'none', op: ops.length > 0 ? ops[0] : undefined }
    }

    function lineDelta(op) {
      if (op.edit !== undefined) {
        var a = op.edit.oldString.split('\n').length
        var b = op.edit.newString.split('\n').length
        return b - a
      }
      if (typeof op.content === 'string') return op.content.split('\n').length
      if (typeof op.read === 'string') return op.read.split('\n').length
      return 0
    }

    // ─────────────────────────── formatting ───────────────────────────
    function clockOf(ms) {
      var d = new Date(ms)
      var pad = function (n) { return n < 10 ? '0' + n : '' + n }
      return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
    }

    function elapsedOf(startedAt, now) {
      var s = Math.max(0, Math.round((now - startedAt) / 1000))
      var m = Math.floor(s / 60)
      var rest = s % 60
      return m > 0 ? m + 'm' + (rest < 10 ? '0' : '') + rest + 's' : s + 's'
    }


    function relPath(path, cwd) {
      if (typeof cwd !== 'string' || cwd.length === 0) return path
      var normCwd = cwd.replace(/\\/g, '/')
      var normPath = path.replace(/\\/g, '/')
      var sameCase = /^[a-z]:/i.test(normCwd)
      var c = sameCase ? normCwd.toLowerCase() : normCwd
      var p = sameCase ? normPath.toLowerCase() : normPath
      if (p === c) return '.'
      if (p.indexOf(c + '/') === 0) return path.slice(cwd.length + 1)
      return path
    }

    function splitLines(text) {
      return String(text).replace(/\r\n/g, '\n').split('\n')
    }

    // ─────────────────────────── data hooks ───────────────────────────
    var EMPTY_JOBS = { rows: {}, observed: {} }

    /** The session-scoped Conversation source of THIS tab's session. */
    function useConversationSource(ctx, sessionId) {
      var current = null
      var uiSession = ctx.get('uiSession')
      if (uiSession !== undefined && uiSession !== null && uiSession.adapter !== undefined) {
        current = uiSession.adapter.current
      }
      var state = React.useState(function () { return current === null ? undefined : current.getSnapshot() })
      var binding = state[0]
      var setBinding = state[1]
      React.useEffect(function () {
        if (current === null) return undefined
        setBinding(current.getSnapshot())
        return current.subscribe(function () { setBinding(current.getSnapshot()) })
      }, [current])
      if (binding === undefined || binding === null) return undefined
      if (binding.key !== sessionId) return undefined
      var hooks = binding.hooks
      return hooks === undefined ? undefined : hooks.conversation
    }

    /** Both views of one Chat snapshot (re-extracted per published delta). */
    var EMPTY_VIEW = { ops: [], shell: [] }

    function useView(conversation) {
      var state = React.useState(EMPTY_VIEW)
      var view = state[0]
      var setView = state[1]
      React.useEffect(function () {
        if (conversation === undefined || conversation === null) {
          setView(EMPTY_VIEW)
          return undefined
        }
        var read = function () {
          var snap = conversation.getSnapshot()
          var chat = snap !== undefined && snap !== null && snap.views !== undefined
            ? snap.views.get('chat')
            : undefined
          var legacy = chat === undefined || chat === null ? undefined : chat.legacy
          var nodes = legacy === undefined ? [] : legacy.nodes
          var running = legacy === undefined ? [] : legacy.runningCalls
          setView({ ops: extractOps(nodes, running), shell: extractShell(nodes, running) })
        }
        read()
        return conversation.subscribe(read)
      }, [conversation])
      return view
    }

    /** Roster + retained output of the client jobs service, per session. */
    function useJobs(ctx, sessionId, active) {
      var service = ctx.get('jobs')
      var usable = service !== undefined && service !== null
        && typeof service.watchRows === 'function'
        && typeof service.observe === 'function'
        && service.state !== undefined
      var state = React.useState(EMPTY_JOBS)
      var snapshot = state[0]
      var setSnapshot = state[1]
      React.useEffect(function () {
        if (!usable || !active) return undefined
        var release = service.watchRows(sessionId)
        var sync = function () { setSnapshot(service.state.getSnapshot()) }
        sync()
        var unsubscribe = service.state.subscribe(sync)
        return function () {
          unsubscribe()
          release()
        }
      }, [usable, sessionId, active])
      return { usable: usable, service: service, snapshot: snapshot }
    }

    /** Observe one job's retained ring while the pane is on screen. */
    function useObserved(service, usable, active, sessionId, jobId) {
      React.useEffect(function () {
        if (!usable || !active || jobId === undefined) return undefined
        return service.observe(sessionId, jobId)
      }, [usable, active, sessionId, jobId])
    }

    function useTick(active) {
      var state = React.useState(Date.now())
      var now = state[0]
      var setNow = state[1]
      React.useEffect(function () {
        if (!active) return undefined
        var id = setInterval(function () { setNow(Date.now()) }, 1000)
        return function () { clearInterval(id) }
      }, [active])
      return now
    }

    // ───────────────────────────── pieces ─────────────────────────────
    function Section(props) {
      return h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: props.flex || 1, borderTop: '1px solid ' + C.border } }, [
        h('div', {
          key: 'head',
          style: {
            display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px',
            fontSize: 11, letterSpacing: '.02em', color: C.dim, background: C.bg2,
            borderBottom: '1px solid ' + C.border, flex: 'none',
            // Never let a long sibling shrink the title into a vertical column,
            // and never let the row spill past the pane.
            minWidth: 0, overflow: 'hidden', flexWrap: 'nowrap',
          },
        }, [
          h('span', {
            key: 'title',
            style: { color: C.text, fontWeight: 600, flex: 'none', whiteSpace: 'nowrap' },
          }, props.title),
          props.extra === undefined
            ? h('span', { key: 'extra', style: { flex: '1 1 auto', minWidth: 0 } })
            : h('span', {
              key: 'extra',
              title: typeof props.extra === 'string' ? props.extra : undefined,
              style: {
                flex: '1 1 auto', minWidth: 0, opacity: 0.85,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              },
            }, props.extra),
          props.actions === undefined
            ? null
            : h('span', {
              key: 'actions',
              style: { flex: 'none', display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 },
            }, props.actions),
        ]),
        h('div', {
          key: 'body',
          style: Object.assign({
            flex: 1, minHeight: 0, overflow: 'auto', background: C.base,
            padding: props.pad === false ? 0 : '6px 10px',
          }, props.bodyStyle || {}),
        }, props.children),
      ])
    }

    function Badge(props) {
      var color = props.color || C.dim
      return h('span', {
        style: {
          display: 'inline-block', padding: '0 5px', borderRadius: 4, fontSize: 10,
          lineHeight: '16px', color: color, border: '1px solid ' + color,
          background: 'transparent', flex: 'none',
        },
      }, props.children)
    }

    function Button(props) {
      return h('button', {
        type: 'button',
        onClick: props.onClick,
        title: props.title,
        style: {
          font: 'inherit', fontSize: 11, lineHeight: '18px', padding: '0 7px',
          borderRadius: 4, cursor: 'pointer', whiteSpace: 'nowrap',
          color: props.active === true ? '#fff' : C.text,
          background: props.active === true ? C.brand : 'transparent',
          border: '1px solid ' + (props.active === true ? C.brand : C.border2),
        },
      }, props.children)
    }

    // ── expansion memory ──
    //
    // The reader's 展开/折叠 choice must survive the tab body remounting
    // (session switches, closing and reopening the tab, a page reload) and it
    // must belong to ONE command: a plain useState in the block both forgets on
    // remount and bleeds one command's state onto the next one selected.
    // Keyed by Session, then by command identity (job id / call id).
    var EXPAND_STORAGE_PREFIX = 'dsh-live-run:expand:'
    var EXPAND_CAP = 200
    var expansionBySession = new Map()

    /** The remembered-command map of one Session (page-lifetime + sessionStorage). */
    function expansionFor(sessionId) {
      var map = expansionBySession.get(sessionId)
      if (map !== undefined) return map
      map = {}
      try {
        if (typeof sessionStorage !== 'undefined') {
          var raw = sessionStorage.getItem(EXPAND_STORAGE_PREFIX + sessionId)
          if (raw !== null && raw !== '') {
            var parsed = JSON.parse(raw)
            if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) map = parsed
          }
        }
      } catch (error) {
        /* storage may be unavailable (private mode, quota) */
      }
      expansionBySession.set(sessionId, map)
      return map
    }

    function expansionOf(sessionId, key) {
      if (key === '') return false
      return expansionFor(sessionId)[key] === true
    }

    function rememberExpansion(sessionId, key, expanded) {
      if (key === '') return
      var map = expansionFor(sessionId)
      if (expanded === true) map[key] = true
      else delete map[key]
      var keys = Object.keys(map)
      if (keys.length > EXPAND_CAP) {
        // Bounded: forget the oldest remembered commands first.
        for (var i = 0; i < keys.length - EXPAND_CAP; i++) delete map[keys[i]]
      }
      try {
        if (typeof sessionStorage !== 'undefined') {
          sessionStorage.setItem(EXPAND_STORAGE_PREFIX + sessionId, JSON.stringify(map))
        }
      } catch (error) {
        /* quota or unavailable — the in-memory map still works */
      }
    }

    /** Stable identity for a command that carries no job/call id. */
    function hashText(text) {
      var hash = 0
      for (var i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0
      return (hash >>> 0).toString(36)
    }

    /** Drop every remembered expansion of one Session (the switch was turned off). */
    function forgetExpansion(sessionId) {
      expansionBySession.delete(sessionId)
      try {
        if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(EXPAND_STORAGE_PREFIX + sessionId)
      } catch (error) {
        /* storage may be unavailable */
      }
    }

    // ── plugin-owned settings (better-sidebar 侧边卡设置 rows) ──
    //
    // The rows are declared on the tab descriptor as `settings.pluginToggles`;
    // their values live in the side card prefs document under
    // `pluginSettings[<descriptor id>]`, and the store publishes every change —
    // so reading them here is enough to apply a flip without a reload.
    var DESCRIPTOR_ID = 'dsh-live-run:pane'
    var EMPTY_SETTINGS = { rememberExpansion: true, copyOneLine: false }

    function readSettings(store) {
      if (store === undefined || store === null || typeof store.getSnapshot !== 'function') return EMPTY_SETTINGS
      var snapshot = store.getSnapshot()
      var prefs = snapshot === undefined || snapshot === null ? undefined : snapshot.prefs
      var map = prefs === undefined || prefs === null ? undefined : prefs.pluginSettings
      var blob = map === undefined || map === null ? undefined : map[DESCRIPTOR_ID]
      return {
        rememberExpansion: blob === undefined || blob === null || blob.rememberExpansion !== false,
        copyOneLine: blob !== undefined && blob !== null && blob.copyOneLine === true,
      }
    }

    function useSettings(store) {
      var state = React.useState(function () { return readSettings(store) })
      var settings = state[0]
      var setSettings = state[1]
      React.useEffect(function () {
        if (store === undefined || store === null || typeof store.subscribe !== 'function') return undefined
        var sync = function () {
          var next = readSettings(store)
          setSettings(function (previous) {
            if (previous !== undefined && previous.rememberExpansion === next.rememberExpansion
              && previous.copyOneLine === next.copyOneLine) return previous
            return next
          })
        }
        sync()
        return store.subscribe(sync)
      }, [store])
      return settings
    }

    /**
     * Squeeze a script into ONE pasteable line, or refuse when that would
     * change its meaning.
     *
     * Newline is a statement separator in both shells, so joining statements
     * with `; ` is safe; joining a CONTINUATION with a space is safe too. Three
     * shapes are not: a here-string/heredoc body is literal, a trailing comment
     * would swallow the next statement, and a quoted string may span lines
     * (joining would insert text INTO the string — syntactically valid, silently
     * different). Those are refused instead of mangled.
     *
     * The PowerShell rules below were validated against the real parser
     * (tools/feasibility-one-line.mjs + Parser::ParseInput); the bash branch is
     * the same shape and deliberately conservative.
     */
    var CONTINUES = { '|': 1, ',': 1, '{': 1, '(': 1, '[': 1, '&': 1, '=': 1, '+': 1, '-': 1, '*': 1, '/': 1, '%': 1, '^': 1, '!': 1, '.': 1, ':': 1 }

    function shellFamily(kind) {
      var value = String(kind === undefined || kind === null ? '' : kind).toLowerCase()
      return value.indexOf('bash') >= 0 || value === 'sh' || value === 'zsh' ? 'bash' : 'pwsh'
    }

    function toOneLine(text, kind) {
      var family = shellFamily(kind)
      var normalized = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      var lines = normalized.split('\n').map(function (line) { return line.replace(/[ \t]+$/, '') })
      while (lines.length > 0 && lines[0] === '') lines.shift()
      while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
      if (lines.length <= 1) return { kind: 'as-is', text: normalized.trim() }

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i]
        if (family === 'pwsh') {
          if (/@(['"])$/.test(line)) return { kind: 'refuse', reason: 'here-string' }
          if (/^['"]@/.test(line.trim())) return { kind: 'refuse', reason: 'here-string' }
        } else if (/<<-?\s*['"]?\w+/.test(line)) {
          return { kind: 'refuse', reason: 'heredoc' }
        }
      }

      for (var c = 0; c < lines.length; c++) {
        var withoutStrings = lines[c].replace(/"([^"`]|`.)*"|'[^']*'/g, '""')
        if (/(^|\s)#/.test(withoutStrings)) return { kind: 'refuse', reason: 'comment' }
      }

      // A quoted string may span physical lines: refuse rather than inject.
      var open = null
      for (var q = 0; q < lines.length; q++) {
        var current = lines[q]
        for (var k = 0; k < current.length; k++) {
          var ch = current.charAt(k)
          if (open === null) {
            if (ch === '"' || ch === "'") open = ch
          } else if (ch === open) {
            if (current.charAt(k + 1) === open) { k += 1; continue }
            open = null
          }
        }
        if (open !== null) return { kind: 'refuse', reason: 'multi-line string' }
      }

      var out = lines[0]
      var continuation = family === 'pwsh' ? '`' : '\\'
      for (var n = 1; n < lines.length; n++) {
        var next = lines[n].trim()
        if (next === '') continue
        if (out.charAt(out.length - 1) === continuation) {
          out = out.slice(0, -1) + ' ' + next
          continue
        }
        var lastChar = out.charAt(out.length - 1)
        var startsCloser = /^(\}|\)|\]|\||&&|\|\||;)/.test(next)
        out = (startsCloser === true || CONTINUES[lastChar] === 1) ? out + ' ' + next : out + '; ' + next
      }
      return { kind: 'joined', text: out }
    }

    var REFUSE_LABEL = {
      'here-string': 'here-string（内容必须多行）',
      heredoc: 'heredoc（内容必须多行）',
      comment: '注释（拼成一行会把后面吞进注释）',
      'multi-line string': '跨行字符串（拼成一行会改字符串内容）',
    }

    /**
     * What the copy button puts on the clipboard, and what to tell the reader.
     * `oneLine` is the setting; the fallback is always the original command so
     * a copy can never fail.
     */
    function copyPayload(command, kind, oneLine) {
      if (oneLine !== true) return { text: command, notice: '' }
      var result = toOneLine(command, kind)
      if (result.kind === 'refuse') {
        return { text: command, notice: '含' + REFUSE_LABEL[result.reason] + '，已按原样复制' }
      }
      if (result.kind === 'as-is') return { text: result.text, notice: '本来就是一行' }
      return { text: result.text, notice: '已折成一行' }
    }

    // Clipboard is injectable so the offline harness can assert the exact bytes.
    var clipboardWriter = null

    function writeClipboard(text) {
      if (clipboardWriter !== null) return Promise.resolve(clipboardWriter(text) !== false)
      if (typeof navigator === 'undefined' || navigator.clipboard === undefined) return Promise.resolve(false)
      return navigator.clipboard.writeText(text).then(function () { return true }, function () { return false })
    }

    /** First line of a possibly multi-line value, capped for a one-line slot. */
    function firstLine(text, max) {
      var value = String(text === undefined || text === null ? '' : text).replace(/\r/g, '')
      var newline = value.indexOf('\n')
      var truncated = false
      if (newline >= 0) {
        value = value.slice(0, newline)
        truncated = true
      }
      if (value.length > max) {
        value = value.slice(0, max)
        truncated = true
      }
      return truncated ? value + '…' : value
    }

    /**
     * The full command of the selected job (or the latest shell call).
     *
     * A pwsh here-string / one-liner can be hundreds of characters wide and
     * carry newlines, so it never belongs in a single-line header slot: one
     * line with an ellipsis by default, and an explicit 展开 that switches to
     * wrapped text (scrollable past a few lines) plus a 折叠 to put it back.
     *
     * `expanded` is the SEED from the session's expansion memory (the caller
     * remounts this block per command id, so switching commands cannot carry
     * one command's state onto another); every toggle reports back through
     * `onToggle` so the choice outlives this mount.
     */
    function CommandBlock(props) {
      var expandedState = React.useState(props.expanded === true)
      var expanded = expandedState[0]
      var setExpanded = expandedState[1]
      var command = props.command === undefined || props.command === null ? '' : String(props.command)
      var long = command.length > 60 || command.indexOf('\n') !== -1
      var feedbackState = React.useState('')
      var feedback = feedbackState[0]
      var setFeedback = feedbackState[1]

      function copy() {
        var payload = copyPayload(command, props.shellKind, props.copyOneLine === true)
        writeClipboard(payload.text).then(function (ok) {
          if (ok !== true) {
            setFeedback('复制失败')
            return
          }
          setFeedback(payload.notice === '' ? '已复制' : payload.notice)
          setTimeout(function () { setFeedback('') }, 2600)
        })
      }

      return h('div', {
        style: {
          display: 'flex', alignItems: 'flex-start', gap: 6,
          padding: '4px 10px 5px', borderBottom: '1px solid ' + C.border,
          background: C.bg, minWidth: 0,
        },
      }, [
        h('span', { key: 'p', style: { color: C.brand, flex: 'none', fontFamily: MONO, fontSize: 11 } }, '$'),
        h('div', {
          key: 'c',
          title: command,
          style: {
            flex: '1 1 auto', minWidth: 0, fontFamily: MONO, fontSize: 11, lineHeight: '16px',
            color: C.text,
            whiteSpace: expanded ? 'pre-wrap' : 'pre',
            overflowX: 'hidden',
            overflowY: expanded ? 'auto' : 'hidden',
            textOverflow: expanded ? 'clip' : 'ellipsis',
            wordBreak: 'break-word',
            overflowWrap: 'anywhere',
            maxHeight: expanded ? 132 : 16,
          },
        }, command === '' ? '（命令未知）' : command),
        long
          ? h(Button, {
            key: 't',
            active: expanded,
            title: expanded ? '折叠为一行' : '展开完整命令',
            onClick: function () {
              var next = !expanded
              setExpanded(next)
              if (typeof props.onToggle === 'function') props.onToggle(next)
            },
          }, expanded ? '折叠' : '展开')
          : null,
        h(Button, {
          key: 'cp',
          title: props.copyOneLine === true ? '复制为可粘贴的一行（无法安全折行时原样复制）' : '复制命令原文',
          onClick: copy,
        }, props.copyOneLine === true ? '复制一行' : '复制'),
        feedback === ''
          ? null
          : h('span', {
            key: 'fb',
            style: {
              flex: 'none', fontSize: 10, lineHeight: '16px', maxWidth: 150,
              color: feedback === '复制失败' ? C.err : C.dim,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            },
            title: feedback,
          }, feedback),
      ])
    }

    function CodeLines(props) {
      var lines = splitLines(props.text)
      var head = props.head === undefined ? -1 : props.head
      var tail = props.tail === undefined ? -1 : props.tail
      var shown = []
      var omitted = 0
      if (head >= 0 && lines.length > head + tail) {
        for (var i = 0; i < head; i++) shown.push({ n: i + 1, text: lines[i] })
        omitted = lines.length - head - tail
        for (var j = lines.length - tail; j < lines.length; j++) shown.push({ n: j + 1, text: lines[j] })
      } else {
        for (var k = 0; k < lines.length; k++) shown.push({ n: k + 1, text: lines[k] })
      }
      var rows = []
      for (var r = 0; r < shown.length; r++) {
        rows.push(h('div', { key: 'l' + r, style: { display: 'flex', gap: 8 } }, [
          h('span', {
            key: 'n',
            style: { width: 42, flex: 'none', textAlign: 'right', color: C.dim, opacity: 0.6, userSelect: 'none' },
          }, String(shown[r].n)),
          h('span', { key: 't', style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', flex: 1 } }, shown[r].text === '' ? ' ' : shown[r].text),
        ]))
        if (omitted > 0 && r === head - 1) {
          rows.push(h('div', {
            key: 'omit',
            style: { margin: '3px 0', color: C.warn, fontSize: 11, paddingLeft: 50 },
          }, '…… 省略 ' + omitted + ' 行 ……'))
        }
      }
      return h('div', { style: { fontFamily: MONO, fontSize: 11.5, lineHeight: '17px', color: C.text } }, rows)
    }

    function DiffView(props) {
      var oldLines = splitLines(props.edit.oldString)
      var newLines = splitLines(props.edit.newString)
      var CAP = 160
      var rows = []
      var add = function (text, sign, color, bg) {
        rows.push(h('div', {
          key: 'd' + rows.length,
          style: {
            display: 'flex', gap: 8, background: bg,
            borderLeft: '2px solid ' + color, paddingLeft: 4,
          },
        }, [
          h('span', { key: 's', style: { flex: 'none', width: 10, color: color, userSelect: 'none' } }, sign),
          h('span', { key: 't', style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', flex: 1 } }, text === '' ? ' ' : text),
        ]))
      }
      var oldShown = Math.min(oldLines.length, CAP)
      for (var i = 0; i < oldShown; i++) add(oldLines[i], '−', C.err, 'rgba(229,83,75,.10)')
      if (oldLines.length > oldShown) rows.push(h('div', { key: 'o-trunc', style: { color: C.dim, fontSize: 11, paddingLeft: 14 } }, '… 旧内容还有 ' + (oldLines.length - oldShown) + ' 行'))
      var newShown = Math.min(newLines.length, CAP)
      for (var j = 0; j < newShown; j++) add(newLines[j], '+', C.ok, 'rgba(46,160,67,.12)')
      if (newLines.length > newShown) rows.push(h('div', { key: 'n-trunc', style: { color: C.dim, fontSize: 11, paddingLeft: 14 } }, '… 新内容还有 ' + (newLines.length - newShown) + ' 行'))
      return h('div', { style: { fontFamily: MONO, fontSize: 11.5, lineHeight: '17px', color: C.text } }, rows)
    }

    var KIND_LABEL = { read: '读', write: '写', edit: '改' }
    var KIND_COLOR = { read: C.dim, write: C.ok, edit: C.warn }

    function OpRow(props) {
      var op = props.op
      var delta = lineDelta(op)
      var color = op.running ? C.brand : (op.isError ? C.err : KIND_COLOR[op.kind])
      var label = op.running ? '…' : (op.isError ? 'x' : KIND_LABEL[op.kind])
      return h('div', {
        onClick: props.onPick,
        title: op.path,
        style: {
          display: 'flex', alignItems: 'center', gap: 7, padding: '2px 4px',
          borderRadius: 4, cursor: 'pointer', fontFamily: MONO, fontSize: 11.5,
          background: props.selected ? 'rgba(76,141,255,.14)' : 'transparent',
        },
      }, [
        h('span', { key: 't', style: { color: C.dim, flex: 'none', userSelect: 'none' } }, clockOf(op.time)),
        h('span', {
          key: 'k',
          style: {
            flex: 'none', width: 16, textAlign: 'center', color: color,
            border: '1px solid ' + color, borderRadius: 3, lineHeight: '14px', fontSize: 10,
          },
        }, label),
        h('span', {
          key: 'p',
          style: {
            flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
            whiteSpace: 'nowrap', color: C.text,
          },
        }, relPath(op.path, props.cwd)),
        op.viaCode === true || op.presentOnly === true
          ? h('span', { key: 'v', style: { color: C.dim, fontSize: 10, flex: 'none' } }, op.viaCode === true ? 'code' : 'present')
          : null,
        delta !== 0 ? h('span', {
          key: 'd',
          style: { flex: 'none', fontSize: 10, color: op.kind === 'write' ? C.ok : C.warn },
        }, (delta > 0 ? '+' : '') + delta) : null,
      ])
    }

    // ───────────────────────────── the tab ─────────────────────────────
    function LiveRunTab(props) {
      var ctx = props.ctx
      var scope = props.scope || {}
      var sessionId = typeof scope.sessionId === 'string' ? scope.sessionId : ''
      var cwd = typeof scope.cwd === 'string' ? scope.cwd : undefined
      var active = props.visible !== false
      var settings = useSettings(props.store)
      var keepExpansion = settings.rememberExpansion
      var copyOneLine = settings.copyOneLine

      var conversation = useConversationSource(ctx, sessionId)
      var view = useView(conversation)
      var ops = view.ops
      var shell = view.shell
      var jobs = useJobs(ctx, sessionId, active)

      var pinState = React.useState(undefined)
      var pinned = pinState[0]
      var setPinned = pinState[1]

      // Last non-empty observation of the selected job: a foreground shell
      // call's job record is REMOVED once it settles, so this is what keeps
      // its output on screen until the conversation log takes over.
      var stickyRef = React.useRef(null)
      var stickyState = React.useState(null)
      var sticky = stickyState[0]
      var setSticky = stickyState[1]

      // Group ops by path, newest first per file.
      var grouped = React.useMemo(function () {
        var map = new Map()
        for (var i = 0; i < ops.length; i++) {
          var op = ops[i]
          var key = op.path
          var list = map.get(key)
          if (list === undefined) { map.set(key, [op]) } else { list.push(op) }
        }
        return map
      }, [ops])

      var newestPath = ops.length > 0 ? ops[0].path : undefined
      var followedPath = pinned !== undefined ? pinned : newestPath
      var followedOps = followedPath === undefined ? [] : (grouped.get(followedPath) || [])
      var payload = payloadOf(followedOps)
      var runningNow = 0
      for (var r = 0; r < ops.length; r++) if (ops[r].running) runningNow++

      // ── command jobs ──
      var roster = Array.isArray(jobs.snapshot.rows[sessionId]) ? jobs.snapshot.rows[sessionId] : []
      var chosenState = React.useState(undefined)
      var chosen = chosenState[0]
      var setChosen = chosenState[1]
      var liveJob = undefined
      for (var ji = 0; ji < roster.length; ji++) {
        if (roster[ji].status === 'running') { liveJob = roster[ji]; break }
      }
      var selectedJob
      if (chosen !== undefined) {
        for (var ci = 0; ci < roster.length; ci++) if (roster[ci].id === chosen) selectedJob = roster[ci]
      }
      if (selectedJob === undefined) selectedJob = liveJob !== undefined ? liveJob : roster[0]
      var selectedId = selectedJob === undefined ? undefined : selectedJob.id
      useObserved(jobs.service, jobs.usable, active, sessionId, selectedId)
      var observed = selectedId === undefined ? undefined : jobs.snapshot.observed[selectedId]
      var now = useTick(active && (liveJob !== undefined || runningNow > 0))

      var observedText = observed !== undefined && typeof observed.text === 'string' ? observed.text : ''
      React.useEffect(function () {
        if (selectedJob === undefined || observedText === '') return
        stickyRef.current = { id: selectedJob.id, label: selectedJob.label, text: observedText, kind: selectedJob.kind }
      }, [selectedId, observedText])
      React.useEffect(function () {
        if (selectedId !== undefined) return
        var last = stickyRef.current
        if (last === null || last === undefined) return
        if (sticky !== null && sticky.id === last.id) return
        setSticky(last)
      })

      // The command pane's sources, in priority order: the live registry job,
      // the last observation of a removed job, then the conversation log's
      // newest shell call (which is also the whole story without a jobs service).
      var historyEntry = shell.length > 0 ? shell[0] : undefined
      // The FULL command goes to the wrapped block below the header; the header
      // only ever carries a short first-line form (a here-string would
      // otherwise squeeze the section title and run off the pane).
      var fullCommand = selectedJob !== undefined
        ? selectedJob.label
        : (sticky !== null && typeof sticky.label === 'string'
          ? sticky.label
          : (historyEntry !== undefined ? historyEntry.command : ''))
      var commandExtra = selectedJob !== undefined
        ? firstLine(selectedJob.label, 40)
        : (sticky !== null
          ? '已结束 · ' + firstLine(sticky.label, 32)
          : (historyEntry !== undefined
            ? '会话记录 · ' + firstLine(historyEntry.command !== '' ? historyEntry.command : historyEntry.name, 32)
            : '暂无命令任务'))
      var bodyText = selectedJob !== undefined
        ? observedText
        : (sticky !== null ? sticky.text : (historyEntry !== undefined ? historyEntry.output : ''))
      var TAIL2 = 240
      var bodyLines = bodyText === '' ? [] : splitLines(bodyText)
      var bodyTail = bodyLines.length > TAIL2 ? bodyLines.slice(bodyLines.length - TAIL2).join('\n') : bodyText
      var bodyRunning = selectedJob !== undefined && selectedJob.status === 'running'

      // One identity per command, never per selection slot: the seed comes from
      // the Session's memory and the block is remounted under that key.
      var expansionKey = selectedJob !== undefined
        ? 'job:' + selectedJob.id
        : (sticky !== null && typeof sticky.id === 'string'
          ? 'job:' + sticky.id
          : (historyEntry !== undefined
            ? 'call:' + historyEntry.id
            : (fullCommand !== '' ? 'cmd:' + hashText(fullCommand) : '')))
      var commandExpanded = keepExpansion === true && expansionOf(sessionId, expansionKey)

      // The shell family decides the one-line transform's rules.
      var shellKind = selectedJob !== undefined
        ? selectedJob.kind
        : (sticky !== null && typeof sticky.kind === 'string'
          ? sticky.kind
          : (historyEntry !== undefined ? historyEntry.name : ''))

      // Dropping the memory switch also drops what that session already stored,
      // so flipping it back on cannot resurrect stale per-command state.
      var previousKeep = React.useRef(keepExpansion)
      React.useEffect(function () {
        if (previousKeep.current === true && keepExpansion === false) forgetExpansion(sessionId)
        previousKeep.current = keepExpansion
      }, [keepExpansion, sessionId])

      var followActive = pinned === undefined && newestPath !== undefined

      return h('div', {
        style: {
          display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
          color: C.text, background: C.base, fontFamily: SANS, fontSize: 12,
        },
      }, [
        // status strip
        h('div', {
          key: 'strip',
          style: {
            display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px',
            borderBottom: '1px solid ' + C.border, background: C.bg2, flex: 'none',
            fontSize: 11, color: C.dim,
          },
        }, [
          h('span', { key: 'dot', style: { width: 7, height: 7, borderRadius: 4, flex: 'none', background: runningNow > 0 || liveJob !== undefined ? C.ok : C.border2 } }),
          h('span', { key: 's', style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            conversation === undefined
              ? '未连接到本会话（切到该会话后自动接上）'
              : (runningNow > 0 ? runningNow + ' 个文件操作进行中' : ops.length + ' 个文件操作')),
          h('span', { key: 'sp', style: { flex: 'none', width: 8 } }),
          liveJob !== undefined
            ? h('span', { key: 'job', style: { color: C.ok, flex: 'none', whiteSpace: 'nowrap' } }, '命令运行中 ' + elapsedOf(liveJob.startedAt, now))
            : h('span', { key: 'idle', style: { flex: 'none', whiteSpace: 'nowrap' } }, jobs.usable ? '无运行中命令' : '本部署无 jobs 服务'),
        ]),

        // ① current file
        h(Section, {
          key: 'file',
          title: '当前文件',
          flex: 1.35,
          active: followActive,
          extra: followedPath === undefined ? '等待文件操作…' : relPath(followedPath, cwd),
          actions: h('span', { key: 'a', style: { display: 'flex', gap: 6 } }, [
            pinned === undefined
              ? h(Badge, { key: 'f', color: C.brand }, '跟随最新')
              : h(Button, { key: 'unpin', onClick: function () { setPinned(undefined) }, title: '回到自动跟随' }, '跟随最新'),
            payload.op === undefined ? null : h(Badge, { key: 'k', color: payload.op.running ? C.brand : KIND_COLOR[payload.op.kind] },
              payload.op.running ? '进行中' : KIND_LABEL[payload.op.kind] + (payload.op.isError ? ' 失败' : '')),
          ]),
        }, followedPath === undefined
          ? h('div', { style: { color: C.dim, padding: '10px 0', fontSize: 11.5 } },
            '任务还没有读写文件。模型第一次 read/write/edit 时会自动出现在这里。')
          : payload.kind === 'none'
            ? h('div', { style: { color: C.dim, padding: '10px 0', fontSize: 11.5 } },
              payload.op === undefined ? '无内容' : '这次操作没有携带内容（' + KIND_LABEL[payload.op.kind] + '正在执行或结果不含正文）')
            : payload.kind === 'diff'
              ? h(DiffView, { edit: payload.op.edit })
              : payload.kind === 'error'
                ? h('div', { style: { color: C.err, fontFamily: MONO, fontSize: 11.5, whiteSpace: 'pre-wrap' } }, payload.text)
                : h(CodeLines, { text: payload.text, head: 200, tail: 200 })),

        // ② write process
        h(Section, {
          key: 'ops',
          title: '写入过程',
          flex: 0.95,
          extra: ops.length === 0 ? '' : ops.length + ' 条',
          actions: pinned === undefined ? null : h(Button, { onClick: function () { setPinned(undefined) }, title: '取消钉住' }, '取消钉住'),
        }, ops.length === 0
          ? h('div', { style: { color: C.dim, padding: '8px 0', fontSize: 11.5 } }, '暂无文件操作')
          : ops.slice(0, 200).map(function (op, index) {
            return h(OpRow, {
              key: op.id + ':' + index,
              op: op,
              cwd: cwd,
              selected: pinned !== undefined && pinned === op.path,
              onPick: function () { setPinned(pinned === op.path ? undefined : op.path) },
            })
          })),

        // ③ command output
        h(Section, {
          key: 'jobs',
          title: '命令输出',
          flex: 1.15,
          pad: false,
          extra: commandExtra,
          actions: h('span', { key: 'ja', style: { display: 'flex', gap: 6, alignItems: 'center' } }, [
            selectedJob !== undefined
              ? h(Badge, { key: 'st', color: bodyRunning ? C.ok : (selectedJob.status === 'failed' ? C.err : C.dim) },
                bodyRunning ? '运行中 ' + elapsedOf(selectedJob.startedAt, now) : selectedJob.status)
              : (sticky !== null
                ? h(Badge, { key: 'st', color: C.dim }, '已结束')
                : (historyEntry !== undefined
                  ? h(Badge, { key: 'st', color: historyEntry.isError ? C.err : C.dim }, historyEntry.isError ? '失败' : '已完成')
                  : null)),
            roster.length > 1
              ? h('span', { key: 'chips', style: { display: 'flex', gap: 4, flex: '0 1 auto', minWidth: 0, maxWidth: '45%', overflowX: 'auto' } },
                roster.slice(0, 6).map(function (job) {
                  return h(Button, {
                    key: job.id,
                    active: job.id === selectedId,
                    onClick: function () { setChosen(job.id === selectedId ? undefined : job.id) },
                    title: job.label,
                  }, firstLine(job.label, 14))
                }))
              : null,
          ]),
        },
          h('div', {
            key: 'jobs-body',
            style: { display: 'flex', flexDirection: 'column', minHeight: '100%', minWidth: 0 },
          }, [
            fullCommand === ''
              ? null
              : h(CommandBlock, {
                // The memory switch is part of the identity: turning it off
                // remounts the block collapsed, so the change is visible at once.
                key: 'cmd:' + expansionKey + (keepExpansion === true ? '' : ':live'),
                command: fullCommand,
                expanded: commandExpanded,
                shellKind: shellKind,
                copyOneLine: copyOneLine,
                onToggle: function (next) {
                  if (keepExpansion === true) rememberExpansion(sessionId, expansionKey, next)
                },
              }),
            bodyText === '' && bodyRunning === false
              ? h('div', { key: 'empty', style: { color: C.dim, padding: '10px', fontSize: 11.5 } },
                selectedJob === undefined && sticky === null && historyEntry === undefined
                  ? (jobs.usable
                    ? '本会话还没有命令任务。执行 pwsh/bash 命令时会在这里实时滚动输出。'
                    : '本部署没有发布 client jobs 服务，会话里也还没有 shell 调用。')
                  : '（无输出）')
              : h('div', {
                key: 'out',
                style: {
                  padding: '6px 10px', fontFamily: MONO, fontSize: 11.5, lineHeight: '16px',
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: C.text,
                  flex: '1 1 auto', minWidth: 0,
                },
              }, [
                selectedJob === undefined && historyEntry !== undefined
                  ? h('div', { key: 'src', style: { color: C.dim, marginBottom: 4, fontSize: 10.5 } },
                    '输出来自会话记录（前台命令结束后会从任务注册表移除）')
                  : null,
                selectedJob !== undefined && observed !== undefined && observed.gapBefore === true
                  ? h('div', { key: 'gap', style: { color: C.warn, marginBottom: 4 } }, '… 中间有输出被丢弃（环形缓冲上限）…')
                  : null,
                bodyTail === ''
                  ? h('div', { key: 'wait', style: { color: C.dim } }, bodyRunning ? '等待第一段输出…' : '（无输出）')
                  : bodyTail,
                selectedJob !== undefined && observed !== undefined && observed.error !== undefined
                  ? h('div', { key: 'err', style: { color: C.err, marginTop: 6 } }, String(observed.error))
                  : null,
                bodyLines.length > TAIL2
                  ? h('div', { key: 'trunc', style: { color: C.dim, marginTop: 6, fontSize: 10.5 } }, '只显示末尾 ' + TAIL2 + ' 行（共 ' + bodyLines.length + ' 行）')
                  : null,
              ]),
          ])),
      ])
    }

    /** Register the tab on the sidebar service the user actually has. */
    function apply(ctx) {
      ctx.inject(['betterSidebar'], function (sub) {
        var service = sub.get('betterSidebar')
        if (service === undefined || service === null || typeof service.registerTab !== 'function') {
          sub.logger.warn('dsh-live-run: betterSidebar service present but not registrable')
          return
        }
        sub.effect(function () {
          return service.registerTab({
            id: DESCRIPTOR_ID,
            title: '实时运行',
            description: '当前文件 + 写入过程 + 命令实时输出',
            order: 45,
            single: true,
            component: function (tabProps) { return h(LiveRunTab, tabProps) },
            // Plugin-owned rows: the side card settings page renders them under
            // this tab's row and persists the values itself; no host schema.
            settings: {
              pluginToggles: [
                {
                  key: 'rememberExpansion',
                  title: '记住展开/折叠状态',
                  desc: '按会话 + 按命令记忆，关掉面板或刷新后仍保持；关闭时清空本会话已记录的状态',
                  type: 'switch',
                  defaultValue: true,
                },
                {
                  key: 'copyOneLine',
                  title: '复制为可粘贴的一行',
                  desc: '安全时折成一行；含 here-string、注释或跨行字符串时按原样复制并说明原因',
                  type: 'switch',
                  defaultValue: false,
                },
              ],
            },
          })
        }, 'dsh-live-run: live run tab')
      })
    }

    exports.name = 'dsh-live-run'
    exports.inject = []
    exports.apply = apply
    // Pure helpers exposed for the offline smoke test (Cordis ignores extra keys).
    exports.__internals = {
      extractOps: extractOps,
      extractShell: extractShell,
      expansionOf: expansionOf,
      rememberExpansion: rememberExpansion,
      forgetExpansion: forgetExpansion,
      readSettings: readSettings,
      toOneLine: toOneLine,
      copyPayload: copyPayload,
      setClipboardWriter: function (writer) { clipboardWriter = writer },
      payloadOf: payloadOf,
      parseArgs: parseArgs,
      relPath: relPath,
      lineDelta: lineDelta,
    }
    return module.exports
  },
})
