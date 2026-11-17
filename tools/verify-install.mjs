#!/usr/bin/env node
/**
 * Post-install verification: prove the PROFILE can resolve and read the
 * bundle the browser will be served, and that the bundle requests only
 * platform seeds.
 */
import { createRequire } from 'node:module'
import { readFileSync, statSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

/**
 * The profile to check: the desktop profile of the current user by default.
 * `DSH_LIVE_RUN_PROFILE` overrides it (an ABSOLUTE path — note the harness
 * already exports an unrelated `DSH_PROFILE` holding a profile NAME).
 */
const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
const override = process.env.DSH_LIVE_RUN_PROFILE
const PROFILE = override !== undefined && override !== '' ? resolve(override) : resolve(home, '.dsh', 'profiles', 'desktop')
/** This package's own root (the repo checkout), so no machine path is baked in. */
const WORKSPACE = fileURLToPath(new URL('../', import.meta.url))
const requireFrom = createRequire(resolve(PROFILE, 'package.json'))
/** Same path with forward slashes and a trailing separator, for comparisons. */
const WORKSPACE_KEY = WORKSPACE.replace(/\\/g, '/').replace(/\/?$/, '/').toLowerCase()

const failures = []
function check(name, fn) {
  try {
    const detail = fn()
    console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`)
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
    console.log(`  FAIL ${name}: ${error.message}`)
  }
}

console.log('\n[install] profile resolution')
let clientPath = ''
check('profile package is the workspace link', () => {
  const real = realpathSync(requireFrom.resolve('dsh-live-run/package.json'))
  if (!real.replace(/\\/g, '/').toLowerCase().startsWith(WORKSPACE_KEY)) {
    throw new Error('installed copy is not the workspace: ' + real)
  }
  return real.replace(/\\/g, '/').slice(real.replace(/\\/g, '/').lastIndexOf('plugins/'))
})
check('exports["./client"] resolves to a real bundle', () => {
  clientPath = requireFrom.resolve('dsh-live-run/client')
  const size = statSync(clientPath).size
  if (size < 1000) throw new Error('bundle looks empty (' + size + ' bytes)')
  return clientPath.split('/').slice(-2).join('/') + ' (' + size + ' bytes)'
})
check('the served bytes are the workspace bytes', () => {
  const installed = readFileSync(clientPath)
  const source = readFileSync(resolve(WORKSPACE, 'lib/client.js'))
  if (!installed.equals(source)) throw new Error('bundle differs from the workspace file')
  return 'identical'
})
check('dsh.client declares platform web', () => {
  const pkg = requireFrom('dsh-live-run/package.json')
  if (pkg.dsh === undefined || pkg.dsh.client === undefined) throw new Error('no dsh.client')
  if (pkg.dsh.client.platform !== 'web') throw new Error('platform=' + pkg.dsh.client.platform)
  return 'platform=web'
})
check('the bundle requests only platform seeds', () => {
  const source = readFileSync(clientPath, 'utf8')
  const requests = new Set()
  for (const match of source.matchAll(/require\((['"`])([^'"`]+)\1\)/g)) requests.add(match[2])
  const allowed = new Set(['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'])
  const bad = [...requests].filter((spec) => !allowed.has(spec))
  if (bad.length > 0) throw new Error('undeclared module requests: ' + bad.join(', '))
  return [...requests].join(', ')
})
check('the bundle registers itself under the package id', () => {
  const source = readFileSync(clientPath, 'utf8')
  if (!source.includes("id: 'dsh-live-run'")) throw new Error('bundle id mismatch')
  if (!source.includes('registerTab')) throw new Error('no tab registration')
  return 'id matched'
})

console.log('')
if (failures.length > 0) {
  for (const failure of failures) console.error(' - ' + failure)
  process.exit(1)
}
console.log('profile can serve the workspace bundle')
