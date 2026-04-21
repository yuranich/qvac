'use strict'

const test = require('brittle')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const http = require('http')
const IdEnc = require('hypercore-id-encoding')
const promClient = require('prom-client')

const RegistryService = require('../../lib/registry-service')
const RegistryConfig = require('../../lib/config')
const MetricsServer = require('../../lib/metrics-server')
const QvacMetrics = require('../../lib/metrics')
const { AUTOBASE_NAMESPACE } = require('../../shared/constants')
const { createTempStorage } = require('../helpers/test-utils')

const noopLogger = {
  info () {},
  debug () {},
  error () {},
  warn () {}
}

async function createServiceWithMetrics (t, opts = {}) {
  const basePath = await createTempStorage(t)
  const store = new Corestore(basePath)
  await store.ready()

  const swarm = new Hyperswarm({ bootstrap: [] })
  const config = new RegistryConfig({ logger: noopLogger })

  const service = new RegistryService(
    store.namespace(AUTOBASE_NAMESPACE),
    swarm,
    config,
    {
      logger: noopLogger,
      ackInterval: 5,
      skipStorageCheck: true
    }
  )

  await service.ready()

  // Fresh registry per test to avoid metric name collisions
  const registry = new promClient.Registry()
  promClient.register.clear()

  const qvacMetrics = new QvacMetrics(service, { logger: noopLogger })
  service.metrics = qvacMetrics

  const port = opts.port || 0
  const metricsServer = new MetricsServer(promClient.register, {
    port,
    logger: noopLogger
  })
  await metricsServer.ready()

  const actualPort = metricsServer._server.address().port

  return { service, store, swarm, metricsServer, qvacMetrics, port: actualPort, registry }
}

async function cleanup (ctx) {
  if (ctx.metricsServer) await ctx.metricsServer.close().catch(() => {})
  if (ctx.service && ctx.service.opened) await ctx.service.close().catch(() => {})
  if (ctx.swarm) await ctx.swarm.destroy().catch(() => {})
  if (ctx.store) await ctx.store.close().catch(() => {})
  promClient.register.clear()
}

function httpGet (port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }))
    })
    req.on('error', reject)
  })
}

test('MetricsServer serves Prometheus text at /metrics', async (t) => {
  const ctx = await createServiceWithMetrics(t)

  try {
    const res = await httpGet(ctx.port, '/metrics')
    t.is(res.status, 200, 'returns 200')
    t.ok(res.headers['content-type'].includes('text/plain') || res.headers['content-type'].includes('openmetrics'), 'correct content type')
    t.ok(res.body.length > 0, 'body is non-empty')
  } finally {
    await cleanup(ctx)
  }
})

test('MetricsServer returns 404 for non-metrics paths', async (t) => {
  const ctx = await createServiceWithMetrics(t)

  try {
    const res = await httpGet(ctx.port, '/health')
    t.is(res.status, 404, 'returns 404')
  } finally {
    await cleanup(ctx)
  }
})

test('/metrics includes QVAC custom gauges', async (t) => {
  const ctx = await createServiceWithMetrics(t)

  try {
    const res = await httpGet(ctx.port, '/metrics')
    const body = res.body

    t.ok(body.includes('qvac_registry_model_count'), 'has model_count')
    t.ok(body.includes('qvac_registry_total_blob_bytes'), 'has total_blob_bytes')
    t.ok(body.includes('qvac_registry_totals_refreshed_age_seconds'), 'has totals_refreshed_age_seconds')
    t.ok(body.includes('qvac_registry_blob_core_count'), 'has blob_core_count')
    t.ok(body.includes('qvac_registry_view_core_length'), 'has view_core_length')
    t.ok(body.includes('qvac_registry_view_core_contiguous_length'), 'has view_core_contiguous_length')
    t.ok(body.includes('qvac_registry_is_indexer'), 'has is_indexer')
    t.ok(body.includes('qvac_registry_blind_peers_connected'), 'has blind_peers_connected')
    t.ok(body.includes('qvac_registry_blind_peer_connected'), 'has blind_peer_connected')
    t.ok(body.includes('qvac_registry_rpc_requests_total'), 'has rpc_requests_total')
    t.ok(body.includes('qvac_registry_rpc_errors_total'), 'has rpc_errors_total')

    const totalBytesLine = body.split('\n')
      .find(line => line.startsWith('qvac_registry_total_blob_bytes '))
    t.ok(totalBytesLine, 'exports total_blob_bytes as a single series')
    t.ok(totalBytesLine.endsWith(' 0'), 'total_blob_bytes is 0 on an empty registry')

    const modelCountLine = body.split('\n')
      .find(line => line.startsWith('qvac_registry_model_count '))
    t.ok(modelCountLine, 'exports model_count as a single series')
    t.ok(modelCountLine.endsWith(' 0'), 'model_count is 0 on an empty registry')

    t.absent(body.includes('qvac_registry_models_total'), 'legacy models_total name is removed')
    t.absent(body.includes('qvac_registry_blob_cores_total'), 'legacy blob_cores_total name is removed')
    t.absent(body.includes('qvac_registry_model_size_bytes'), 'per-path model_size_bytes metric is removed')

    const rpcPingRequests = body.split('\n')
      .find(line => line.startsWith('qvac_registry_rpc_requests_total{method="ping"}'))
    t.ok(rpcPingRequests, 'rpc_requests_total{method="ping"} series is pre-initialised')
    t.ok(rpcPingRequests.endsWith(' 0'), 'rpc_requests_total{method="ping"} starts at 0')

    const rpcPingErrors = body.split('\n')
      .find(line => line.startsWith('qvac_registry_rpc_errors_total{method="add-model"}'))
    t.ok(rpcPingErrors, 'rpc_errors_total{method="add-model"} series is pre-initialised')
    t.ok(rpcPingErrors.endsWith(' 0'), 'rpc_errors_total{method="add-model"} starts at 0')
  } finally {
    await cleanup(ctx)
  }
})

test('RPC metrics counters increment', async (t) => {
  const ctx = await createServiceWithMetrics(t)

  try {
    ctx.qvacMetrics.recordRpcRequest('ping')
    ctx.qvacMetrics.recordRpcRequest('ping')
    ctx.qvacMetrics.recordRpcRequest('add-model')
    ctx.qvacMetrics.recordRpcError('add-model')

    const res = await httpGet(ctx.port, '/metrics')
    const body = res.body

    const pingLine = body.split('\n').find(l => l.includes('qvac_registry_rpc_requests_total') && l.includes('ping'))
    t.ok(pingLine, 'has ping request counter line')
    t.ok(pingLine.includes('2'), 'ping counter is 2')

    const errorLine = body.split('\n').find(l => l.includes('qvac_registry_rpc_errors_total') && l.includes('add-model'))
    t.ok(errorLine, 'has add-model error counter line')
    t.ok(errorLine.includes('1'), 'error counter is 1')
  } finally {
    await cleanup(ctx)
  }
})

test('blind peer metrics track configured peers with active connections', async (t) => {
  const blindPeerKeys = [
    IdEnc.normalize(Buffer.alloc(32, 1)),
    IdEnc.normalize(Buffer.alloc(32, 2))
  ]
  const ctx = await createServiceWithMetrics(t)

  try {
    ctx.service.blindPeerKeys = blindPeerKeys
    ctx.service._trackPeerConnection(blindPeerKeys[0])
    ctx.service._trackPeerConnection(blindPeerKeys[0])
    ctx.service._trackPeerConnection('writer-peer')

    let res = await httpGet(ctx.port, '/metrics')
    let body = res.body

    const connectedPeerLine = body.split('\n')
      .find(line => line.startsWith(`qvac_registry_blind_peer_connected{peer_key="${blindPeerKeys[0]}"}`))
    t.ok(connectedPeerLine, 'has connected blind peer series')
    t.ok(connectedPeerLine.endsWith(' 1'), 'connected blind peer is reported as 1')

    const disconnectedPeerLine = body.split('\n')
      .find(line => line.startsWith(`qvac_registry_blind_peer_connected{peer_key="${blindPeerKeys[1]}"}`))
    t.ok(disconnectedPeerLine, 'has disconnected blind peer series')
    t.ok(disconnectedPeerLine.endsWith(' 0'), 'disconnected blind peer is reported as 0')

    ctx.service._untrackPeerConnection(blindPeerKeys[0])
    ctx.service._untrackPeerConnection(blindPeerKeys[0])

    res = await httpGet(ctx.port, '/metrics')
    body = res.body

    const afterCloseCountLine = body.split('\n')
      .find(line => line.startsWith('qvac_registry_blind_peers_connected '))
    t.ok(afterCloseCountLine.endsWith(' 0'), 'blind peer count drops after connection closes')

    const afterClosePeerLine = body.split('\n')
      .find(line => line.startsWith(`qvac_registry_blind_peer_connected{peer_key="${blindPeerKeys[0]}"}`))
    t.ok(afterClosePeerLine.endsWith(' 0'), 'blind peer status drops after connection closes')
  } finally {
    await cleanup(ctx)
  }
})

test('MetricsServer closes cleanly', async (t) => {
  const ctx = await createServiceWithMetrics(t)

  await ctx.metricsServer.close()
  ctx.metricsServer = null

  try {
    await httpGet(ctx.port, '/metrics')
    t.fail('should not connect after close')
  } catch (err) {
    t.ok(err.code === 'ECONNREFUSED', 'connection refused after close')
  } finally {
    await cleanup(ctx)
  }
})

test('MetricsServer binds to custom host', async (t) => {
  const basePath = await createTempStorage(t)
  const store = new Corestore(basePath)
  await store.ready()

  const swarm = new Hyperswarm({ bootstrap: [] })
  const config = new RegistryConfig({ logger: noopLogger })

  const service = new RegistryService(
    store.namespace(AUTOBASE_NAMESPACE),
    swarm,
    config,
    { logger: noopLogger, ackInterval: 5, skipStorageCheck: true }
  )
  await service.ready()

  promClient.register.clear()

  const metricsServer = new MetricsServer(promClient.register, {
    port: 0,
    host: '127.0.0.1',
    logger: noopLogger
  })

  const ctx = { service, store, swarm, metricsServer }

  try {
    await metricsServer.ready()

    const address = metricsServer._server.address()
    t.is(address.address, '127.0.0.1', 'bound to requested host')

    const res = await httpGet(address.port, '/metrics')
    t.is(res.status, 200, 'reachable on requested host')
  } finally {
    await cleanup(ctx)
  }
})
