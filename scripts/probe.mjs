/**
 * Live probe for dsh-app-launcher.
 *
 * Three layers, because this plugin has three ways to be wrong, and they fail
 * differently:
 *
 * 1. The ROUTE, driven through the real `apply()` with a stub `webServer` — so it
 *    needs nothing installed and never skips. This is where the refusals live: a
 *    foreign Host, a non-GET method, and the URL schemes that must never reach
 *    `window.open`.
 * 2. The MOUNT on a REAL @deepseek-ai/cordis Context, which proves `inject:
 *    ['webServer']` resolves against the actual service name. Skipped LOUDLY when no
 *    cordis is reachable — a probe that reports success without mounting anything is
 *    worse than no probe.
 * 3. The CLIENT BUNDLE, evaluated against a stub `window.__ModuleLoader__` and a fake
 *    React: it proves the bundle parses, names itself, and registers into the slot it
 *    claims to. What it CANNOT prove is that anything renders — that needs a real
 *    browser, and the README says so.
 *
 * Run: node scripts/probe.mjs        (DSH_CORDIS=/path/to/cordis/lib/index.js to force)
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

let failures = 0
let skipped = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label)
  if (!ok) {
    console.log('   expected: ' + JSON.stringify(expected))
    console.log('   actual:   ' + JSON.stringify(actual))
  }
}
function skip(label, why) {
  skipped += 1
  console.log('SKIP  ' + label + ' — ' + why)
}

const Plugin = await import('../lib/index.js')
const { normalizeApps } = Plugin

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

// ---------------------------------------------------------------- static contract
check('inject lists exactly the real service', Plugin.inject, ['webServer'])
check('package.json declares a web client half', PKG.dsh?.client?.platform, 'web')
check('the client bundle is exported', PKG.exports['./client'].default, './lib/client.js')

const APPS = [
  { label: 'Planner', url: '/daily-progress-tab/ui' },
  { label: 'Cost panel', url: 'http://127.0.0.1:3099/cost-bubble/panel' },
]

// ------------------------------------------------------------------- the route
// `apply` touches only `ctx.effect` and `ctx.webServer.register`, so the route can be
// exercised with a stub — which keeps these checks running everywhere, including on a
// machine with nothing installed.
let route = null
const stubCtx = {
  effect: (fn) => { fn(); return () => {} },
  webServer: { register: (r) => { route = r; return () => { route = null } } },
}
Plugin.apply(stubCtx, { apps: APPS })
check('apply registered a prefix route', route !== null && route.path, '/app-launcher')

function call(method, host = '127.0.0.1:3099', url = '/app-launcher/apps') {
  return new Promise((resolve) => {
    const chunks = []
    const res = {
      status: 0,
      writeHead(code) { this.status = code; return this },
      end(body) { if (body !== undefined) chunks.push(String(body)); resolve({ status: this.status, body: chunks.join('') }) },
    }
    Promise.resolve(route.handler({ method, url, headers: { host } }, res)).catch((error) => {
      resolve({ status: 0, body: 'threw: ' + error.message })
    })
  })
}

const ok = await call('GET')
check('the route answers 200 for loopback', ok.status, 200)
check('and returns the configured apps', JSON.parse(ok.body), { ok: true, apps: APPS })
check('a NON-loopback Host is refused', (await call('GET', 'evil.example')).status, 403)
check('a non-GET method is refused', (await call('POST')).status, 405)

// ------------------------------------------------------- what config may carry
check('a javascript: URL is DROPPED, never handed to window.open',
  normalizeApps({ apps: [{ label: 'x', url: 'javascript:alert(1)' }] }), [])
check('a data: URL is dropped', normalizeApps({ apps: [{ label: 'x', url: 'data:text/html,<b>x' }] }), [])
check('a protocol-relative //host is dropped (it is not same-origin)',
  normalizeApps({ apps: [{ label: 'x', url: '//evil.example/x' }] }), [])
check('an entry with no label or no url is dropped',
  normalizeApps({ apps: [{ url: '/a' }, { label: 'b' }, {}, null, 'nope', 42] }), [])
check('an over-long label or url is dropped',
  normalizeApps({ apps: [{ label: 'x'.repeat(41), url: '/a' }, { label: 'y', url: '/' + 'z'.repeat(300) }] }), [])
check('a valid relative path and a valid absolute http URL both survive', normalizeApps({ apps: APPS }), APPS)
check('no config at all yields no apps (and the pill hides itself)', normalizeApps(undefined), [])

// ---------------------------------------------------------------- the mount
const CORDIS_CANDIDATES = [
  process.env.DSH_CORDIS,
  join(dirname(process.execPath), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'),
  new URL('../../dsh-daily-progress-tab/node_modules/@deepseek-ai/cordis/lib/index.js', import.meta.url).pathname,
].filter(Boolean)

let CordisContext = null
for (const candidate of CORDIS_CANDIDATES) {
  try {
    ({ Context: CordisContext } = await import(candidate))
    break
  } catch { /* try the next candidate */ }
}

if (CordisContext === null) {
  skip('mount on a real cordis Context',
    'no cordis reachable — set DSH_CORDIS=/path/to/@deepseek-ai/cordis/lib/index.js to run this layer')
} else {
  let mounted = null
  const ctx = new CordisContext()
  ctx.provide('webServer', { register: (r) => { mounted = r; return () => { mounted = null } } })
  let activated = false
  ctx.plugin({
    name: 'dsh-app-launcher',
    inject: Plugin.inject,
    apply: (c) => { activated = true; return Plugin.apply(c, { apps: APPS }) },
  })
  await new Promise((r) => setTimeout(r, 200))
  check('ACTIVATED on real cordis (inject resolved against the real service name)', activated, true)
  check('and registered its route there too', mounted !== null && mounted.path, '/app-launcher')
}

// ------------------------------------------------------------ the client half
const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

function loadClient() {
  const captured = []
  const registered = []
  const fakeWindow = {
    location: { origin: 'http://127.0.0.1:3099' },
    open: () => null,
    __ModuleLoader__: { load: (def) => captured.push(def) },
  }
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
  }
  const sandbox = {
    window: fakeWindow,
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, apps: [] }) }),
    URL,
    console,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(clientSource, sandbox, { filename: 'client.js' })
  return { captured, registered, React }
}

const client = loadClient()
check('the client bundle calls the module loader exactly once', client.captured.length, 1)
check('and names itself after the package', client.captured[0]?.id, 'dsh-app-launcher')

const clientExports = client.captured[0].factory((name) => {
  if (name === 'react') return client.React
  throw new Error('unexpected require: ' + name)
})
check('the factory exports apply and inject',
  [typeof clientExports.apply, JSON.stringify(clientExports.inject)], ['function', '["slots","timer"]'])

// A TRIPWIRE, not a proof: the pointer-capture bug cannot be reproduced without a DOM,
// so the guard that prevents it is asserted lexically. It fails if someone removes the
// exclusion — which is the recurrence this line exists to catch.
check('the drag refuses to capture a press that starts inside the panel',
  /closest\("\[data-app\],\[data-panel\]"\).*return/s.test(clientSource), true)

const slots = {
  inject: (name, cb) => { cb() },
  register: (meta, component) => { client.registered.push({ meta, component }); return () => {} },
}
clientExports.apply({ slots, interval: () => () => {} })
check('it registers into the shell overlay slot', client.registered[0]?.meta,
  { name: 'shell.overlay', id: 'app-launcher', order: 90, label: 'Apps' })
check('and registers a component, not a value', typeof client.registered[0]?.component, 'function')

console.log(failures === 0
  ? '\nALL PROBES PASSED' + (skipped > 0 ? ' (' + skipped + ' layer skipped)' : '')
  : '\n' + failures + ' PROBE(S) FAILED')
process.exit(failures === 0 ? 0 : 1)
