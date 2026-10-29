import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { satisfies } from 'semver'
import { apply } from '../lib/index.js'
import manifest from '../package.json' with { type: 'json' }

// `home` points the plugin at a throwaway ~/.kube so a test can exercise the
// kubeconfig routes without touching the real one.
function harness(stdoutForCommand = () => '/usr/bin/kubectl\n', options = {}) {
  const routes = new Map()
  const upgrades = new Map()
  const effects = []
  const executions = []
  const shell = {
    resolve: request => request,
    async execute(spec) {
      let killed = false
      const proc = {
        status: 'running',
        readOutput: () => ({ delta: 'pod output', lossy: false }),
        kill: () => { killed = true; proc.status = 'killed' },
        result: async () => ({ exitCode: 0, stdout: { text: stdoutForCommand(spec.command) }, stderr: { text: '' } }),
        get killed() { return killed },
      }
      executions.push({ spec, proc })
      return proc
    },
  }
  const webServer = {
    register(route) {
      assert.equal(routes.has(route.path), false)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
    registerUpgrade(route) {
      upgrades.set(route.path, route)
      return () => upgrades.delete(route.path)
    },
  }
  const ctx = {
    shell,
    get: key => ({ shell, webServer, subprocess: {} })[key],
    effect: fn => { const dispose = fn(); effects.push(dispose); return dispose },
  }
  // The plugin resolves ~/.kube once, at apply time.
  const previousHome = process.env.HOME
  if (options.home !== undefined) process.env.HOME = options.home
  try {
    apply(ctx)
  } finally {
    if (options.home !== undefined) process.env.HOME = previousHome
  }
  return {
    routes, upgrades, executions,
    dispose: () => effects.reverse().forEach(dispose => dispose()),
    async call(path, body = {}) {
      const req = Readable.from([Buffer.from(JSON.stringify(body))])
      req.method = 'POST'
      let result
      const res = { setHeader() {}, end: text => { result = JSON.parse(text) } }
      await routes.get('/dsh-k8s-manager/' + path).handler(req, res)
      return result
    },
  }
}

const DSH_RUNTIME = '0.2.1-rc.3'

// A minimal kubeconfig: the plugin only needs the apiVersion/kind fields to
// accept it, and the injected context name comes from the mocked kubectl.
const YAML = [
  'apiVersion: v1',
  'kind: Config',
  'clusters: []',
  'contexts: []',
  'users: []',
  '',
].join('\n')

test('manifest targets the rc.3 host SDK and the replacement client renderer', () => {
  assert.equal(manifest.engines.dsh, '>=0.2.1-rc.3 <0.3.0')
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-shell'], '^0.2.1-rc.3')
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-subprocess'], '^0.2.1-rc.3')
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-host-webserver'], '^0.2.1-rc.3')
  assert.equal(manifest.dependencies['node-pty'], undefined)
  assert.deepEqual(manifest.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-renderer'])
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-settings'], undefined)
})

// The profile boot preflight denies a plugin whose dsh requirements the running
// runtime does not satisfy, so the manifest must satisfy the installed host.
test('manifest satisfies the rc.3 runtime the way the boot preflight checks it', () => {
  assert.ok(satisfies(DSH_RUNTIME, manifest.engines.dsh, { includePrerelease: true }))

  // engines.dsh decides alone, but a manifest without it falls back to the DSH
  // peers, so every peer must also accept the runtime it is installed into.
  for (const [name, range] of Object.entries(manifest.peerDependencies)) {
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
    assert.ok(satisfies(DSH_RUNTIME, range, { includePrerelease: true }), name + ' rejects ' + DSH_RUNTIME)
  }
  assert.equal(manifest.peerDependencies['@deepseek-ai/cordis'], '~4.0.5')
})

test('foreground commands use asynchronous execute().result()', async () => {
  const host = harness()
  try {
    assert.equal((await host.call('detect')).kubectl, true)
    assert.equal(host.executions[0].spec.command, 'command -v kubectl')
    assert.equal(host.executions[0].spec.sandboxPolicy.mode, 'workspace-write')
  } finally { host.dispose() }
  assert.equal(host.routes.size, 0)
  assert.equal(host.upgrades.size, 0)
})

test('Pod 列表保留真实 phase，避免用展示状态误筛概览卡片', async () => {
  const table = `NAMESPACE   NAME          READY   STATUS             RESTARTS   AGE
prod        pending-api   0/1     ImagePullBackOff   0          3m
prod        crash-api     0/1     CrashLoopBackOff   5          9m\n`
  const created = '2026-10-01T00:00:00Z'
  const pods = {
    items: [
      { metadata: { name: 'pending-api', namespace: 'prod', creationTimestamp: created }, status: { phase: 'Pending', containerStatuses: [{ state: { waiting: { reason: 'ImagePullBackOff' } } }] } },
      { metadata: { name: 'crash-api', namespace: 'prod', creationTimestamp: created }, status: { phase: 'Running', containerStatuses: [{ state: { waiting: { reason: 'CrashLoopBackOff' } } }] } },
    ],
  }
  const host = harness(command => /-o json$/.test(command) ? JSON.stringify(pods) : table)
  try {
    const result = await host.call('list', { context: 'test', kind: 'pods' })
    assert.equal(result.ok, true)
    assert.equal(result.table, table)
    assert.deepEqual(result.items, [
      { name: 'pending-api', namespace: 'prod', created, phase: 'Pending' },
      { name: 'crash-api', namespace: 'prod', created, phase: 'Running' },
    ])
    assert.equal(host.executions.length, 2)
    assert.ok(host.executions.every(({ spec }) => /kubectl get 'pods' -A/.test(spec.command)))
  } finally { host.dispose() }
})

test('节点列表按 Ready condition 判定就绪，不把 NotReady 误识别为 Ready', async () => {
  const table = `NAME         STATUS                     ROLES    AGE   VERSION
ready-node   Ready,SchedulingDisabled   <none>   20d   v1.34.0
bad-node     NotReady                   <none>   20d   v1.34.0
unknown      Unknown                    <none>   20d   v1.34.0
new-node     Unknown                    <none>   1m    v1.34.0\n`
  const nodes = {
    items: [
      { metadata: { name: 'ready-node' }, status: { conditions: [{ type: 'MemoryPressure', status: 'False' }, { type: 'Ready', status: 'True' }] } },
      { metadata: { name: 'bad-node' }, status: { conditions: [{ type: 'MemoryPressure', status: 'True' }, { type: 'Ready', status: 'False' }] } },
      { metadata: { name: 'unknown' }, status: { conditions: [{ type: 'Ready', status: 'Unknown' }] } },
      { metadata: { name: 'new-node' } },
    ],
  }
  const host = harness(command => /-o json$/.test(command) ? JSON.stringify(nodes) : table)
  try {
    const result = await host.call('list', { context: 'test', kind: 'nodes' })
    assert.equal(result.ok, true)
    assert.equal(result.table, table)
    assert.deepEqual(result.items, [
      { name: 'ready-node', namespace: '', created: '', ready: true },
      { name: 'bad-node', namespace: '', created: '', ready: false },
      { name: 'unknown', namespace: '', created: '', ready: false },
      { name: 'new-node', namespace: '', created: '', ready: false },
    ])
  } finally { host.dispose() }
})


// The host confines subprocess writes to the session workspace, so kubectl's
// lock files and cache under ~/.kube are denied until the plugin names that
// tree as its writable root. Saving a cluster renames a context, which is the
// write that used to fail with `operation not permitted`.
test('saving a cluster grants kubectl write access under ~/.kube', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-k8s-home-'))
  const host = harness(command => command.includes('get-contexts') ? 'in-cluster\n' : '', { home })
  try {
    const result = await host.call('save-kubeconfig', { name: 'demo', yaml: YAML })

    assert.equal(result.ok, true)
    assert.equal(result.name, 'demo')
    assert.equal(readFileSync(join(home, '.kube', 'configs', 'demo.yaml'), 'utf8'), YAML)

    const rename = host.executions.find(({ spec }) => spec.command.includes('rename-context'))
    assert.ok(rename, 'saving renames the provider context to the cluster name')

    // Every kubectl call carries the grant, because the executor defaults an
    // absent policy to the confined mode that just denied this write.
    for (const { spec } of host.executions) {
      assert.deepEqual(spec.sandboxPolicy, {
        mode: 'workspace-write',
        workspaceRoot: join(home, '.kube'),
      }, spec.command)
    }
  } finally {
    host.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('deleting a cluster rewrites the merged config through the same grant', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-k8s-home-'))
  const host = harness(() => '', { home })
  try {
    assert.equal((await host.call('save-kubeconfig', { name: 'demo', yaml: YAML })).ok, true)
    assert.deepEqual(readdirSync(join(home, '.kube', 'configs')), ['demo.yaml'])

    assert.equal((await host.call('delete-kubeconfig', { name: 'demo.yaml' })).ok, true)
    assert.deepEqual(readdirSync(join(home, '.kube', 'configs')), [])
    assert.equal(readFileSync(join(home, '.kube', 'config'), 'utf8'), '')
  } finally {
    host.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('log follow has no expiry, supports polling and stops on unload', async () => {
  const host = harness()
  const { sessionId } = await host.call('logs/start', { context: 'test', namespace: 'default', pod: 'pod' })
  assert.ok(sessionId)
  assert.equal(host.executions[0].spec.onExpiry, 'none')
  assert.equal((await host.call('logs/poll', { sessionId })).delta, 'pod output')
  host.dispose()
  assert.equal(host.executions[0].proc.killed, true)
  assert.equal(host.routes.size, 0)
})

test('invalid log arguments never spawn a process', async () => {
  const host = harness()
  try {
    assert.equal((await host.call('logs/start', { context: '../escape' })).ok, false)
    assert.equal(host.executions.length, 0)
  } finally { host.dispose() }
})

test('built client registers through slots and removes styles on unload', async () => {
  const { readFileSync } = await import('node:fs')
  const { runInNewContext } = await import('node:vm')
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url)
  const styles = []
  let client
  const document = {
    createElement: () => ({ remove() { styles.splice(styles.indexOf(this), 1) } }),
    head: { appendChild: style => styles.push(style) },
  }
  runInNewContext(readFileSync(new URL('../client/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: ({ id, factory }) => {
      assert.equal(id, 'dsh-k8s-manager')
      client = factory(require)
    } } },
    document, console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    navigator: { platform: "MacIntel", userAgent: "Macintosh", language: "zh-CN" },
  })
  assert.deepEqual(Array.from(client.inject), ['slots'])
  const effects = []
  const registrations = new Map()
  client.apply({
    get: () => ({
      inject(key, callback) {
        assert.ok(['main', 'sidebar.panellist', 'conversation.view'].includes(key))
        effects.push(callback())
      },
      register(options, component) {
        assert.equal(options.key ?? options.id, 'k8s-manager')
        registrations.set(options.name, { options, component })
        return () => { registrations.delete(options.name) }
      },
    }),
    effect: fn => { effects.push(fn()) },
  })
  assert.deepEqual([...registrations.keys()], ['main', 'sidebar.panellist', 'conversation.view'])
  const sidebar = registrations.get('sidebar.panellist')
  assert.equal(sidebar.options.label, 'Kubernetes')
  assert.equal(sidebar.options.order, 1)
  assert.equal(registrations.get('main').options.key, sidebar.options.id)
  assert.equal(sidebar.component({ size: 18 }).props.width, 18)
  const count = styles.length
  effects.reverse().forEach(dispose => dispose())
  assert.equal(registrations.size, 0)
  assert.equal(count, 1)
  assert.equal(styles.length, 0)
})
