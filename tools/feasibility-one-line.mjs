#!/usr/bin/env node
/**
 * Feasibility probe for "copy as a pasteable ONE LINE" (PowerShell source).
 *
 * A client-side transform cannot be validated in the browser, so every
 * candidate it produces is parsed here by THIS machine's PowerShell parser
 * ([System.Management.Automation.Language.Parser]::ParseInput). A candidate
 * that parses with errors is a failed transform; an original that fails too is
 * a bad sample.
 *
 * The interesting part is not the happy path: comments, here-strings and
 * MULTI-LINE STRINGS all survive the transform syntactically while changing
 * meaning, so they have to be refused, not joined.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const OUT_DIR = fileURLToPath(new URL('.feasibility/', import.meta.url))

/** Characters that make the next physical line a continuation of this one. */
const CONTINUES = new Set(['|', ',', '{', '(', '[', '&', '=', '+', '-', '*', '/', '%', '^', '!', '.', ':'])

/**
 * Refuse when the text must stay multi-line, join it otherwise.
 * @returns {{kind:'refuse'|'joined'|'as-is', reason?:string, text?:string}}
 */
function toOneLine(text) {
  const normalized = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const raw = normalized.split('\n').map((line) => line.replace(/[ \t]+$/, ''))
  while (raw.length > 0 && raw[0] === '') raw.shift()
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop()
  if (raw.length <= 1) return { kind: 'as-is', text: normalized.trim() }

  // 1. Here-strings: their body is literal and MUST stay multi-line.
  for (const line of raw) {
    if (/@(['"])$/.test(line)) return { kind: 'refuse', reason: 'here-string' }
    if (/^['"]@/.test(line.trim())) return { kind: 'refuse', reason: 'here-string' }
  }

  // 2. Comments: joining after one swallows the next statement; a comment that
  //    rides at the end of a line breaks the same way.
  for (const line of raw) {
    const withoutStrings = line.replace(/"([^"`]|`.)*"|'[^']*'/g, '""')
    if (/(^|\s)#/.test(withoutStrings)) return { kind: 'refuse', reason: 'comment' }
  }

  // 3. A plain quoted string may span lines. `"a` + newline + `b"` is ONE
  //    string; joining inserts text INTO it, and the parser would not complain.
  let open = null
  for (const line of raw) {
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (open === null) {
        if (ch === '"' || ch === "'") open = ch
      } else if (ch === open) {
        // a doubled quote escapes itself
        if (line[i + 1] === open) { i += 1; continue }
        open = null
      }
    }
    if (open !== null) return { kind: 'refuse', reason: 'multi-line string' }
  }

  let out = raw[0]
  for (let i = 1; i < raw.length; i++) {
    const next = raw[i].trim()
    if (next === '') continue
    // Backtick at end of line is an explicit continuation: drop it, join space.
    if (out.endsWith('`')) {
      out = `${out.slice(0, -1)} ${next}`
      continue
    }
    const lastChar = out[out.length - 1]
    const startsCloser = /^(\}|\)|\]|\||&&|\|\|)/.test(next)
    const joinSpace = startsCloser || CONTINUES.has(lastChar)
    out = joinSpace ? `${out} ${next}` : `${out}; ${next}`
  }
  return { kind: 'joined', text: out }
}

const SAMPLES = [
  {
    id: 'here-string (user screenshot)',
    expect: 'refuse',
    text: "$script = @'\necho \"=== 功能验证 1 ===\"\nssh -o StrictHostKeyChecking=no root@10.0.0.2 'echo hi'\n'@\n& $script",
  },
  { id: 'pipeline continuation', expect: 'joined', text: 'Get-ChildItem -Recurse |\n  Where-Object { $_.Length -gt 1MB } |\n  Select-Object Name, Length' },
  { id: 'backtick continuation', expect: 'joined', text: 'Write-Host `\n  "hello" -ForegroundColor Green' },
  { id: 'statements', expect: 'joined', text: 'cd C:\\work\nnpm run build\necho done' },
  { id: 'script block', expect: 'joined', text: 'if ($true) {\n  Write-Host one\n}' },
  { id: 'trailing comment', expect: 'refuse', text: 'Get-ChildItem # list files\nRemove-Item x' },
  { id: 'already one line', expect: 'as-is', text: 'Get-Date' },
  { id: 'and-and continuation', expect: 'joined', text: 'npm test &&\n  npm run build' },
  { id: 'assignment continuation', expect: 'joined', text: '$x =\n  5' },
  { id: 'arithmetic continuation', expect: 'joined', text: 'Write-Host (1 +\n  2)' },
  { id: 'multi-line string', expect: 'refuse', text: '$msg = "line one\nline two"' },
  { id: 'array literal', expect: 'joined', text: '$a = @(\n  1, 2, 3\n)' },
]

const results = SAMPLES.map((sample) => {
  const decision = toOneLine(sample.text)
  return {
    id: sample.id,
    expect: sample.expect,
    actual: decision.kind,
    reason: decision.reason,
    decisionOk: decision.kind === sample.expect,
    original: sample.text,
    candidate: decision.kind === 'joined' || decision.kind === 'as-is' ? decision.text : null,
  }
})

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(`${OUT_DIR}/candidates.json`, JSON.stringify(results, null, 2), 'utf8')

console.log('decision table:')
let failed = 0
for (const row of results) {
  if (!row.decisionOk) failed += 1
  console.log(`  ${row.decisionOk ? 'ok  ' : 'FAIL'} ${row.id} — ${row.actual}${row.reason ? ' (' + row.reason + ')' : ''}`)
}
console.log(`\n${results.filter((r) => r.candidate !== null).length} candidate(s) queued for the PowerShell parser`)
if (failed > 0) {
  console.error(`${failed} decision(s) differ from expectation`)
  process.exit(1)
}
