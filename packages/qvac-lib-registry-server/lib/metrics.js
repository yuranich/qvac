'use strict'

const promClient = require('prom-client')

const MODEL_CACHE_TTL_MS = 15000

class QvacMetrics {
  constructor (service, opts = {}) {
    this._service = service
    this._logger = opts.logger || console

    this._modelCache = null
    this._modelCacheExpiry = 0

    this._rpcRequests = new promClient.Counter({
      name: 'qvac_registry_rpc_requests_total',
      help: 'Total RPC requests by method',
      labelNames: ['method']
    })

    this._rpcErrors = new promClient.Counter({
      name: 'qvac_registry_rpc_errors_total',
      help: 'Total RPC errors by method',
      labelNames: ['method']
    })

    this._registerGauges()
  }

  recordRpcRequest (method) {
    this._rpcRequests.inc({ method })
  }

  recordRpcError (method) {
    this._rpcErrors.inc({ method })
  }

  _registerGauges () {
    const self = this

    // eslint-disable-next-line no-new
    new promClient.Gauge({
      name: 'qvac_registry_models_total',
      help: 'Total number of models in the registry',
      async collect () {
        const models = await self._getCachedModels()
        this.set(models.length)
      }
    })

    // eslint-disable-next-line no-new
    new promClient.Gauge({
      name: 'qvac_registry_blob_cores_total',
      help: 'Number of blob cores',
      collect () {
        this.set(self._service.blobsCores.size)
      }
    })

    // eslint-disable-next-line no-new
    new promClient.Gauge({
      name: 'qvac_registry_blob_core_peers',
      help: 'Number of connected peers per blob core',
      labelNames: ['core_name'],
      collect () {
        this.reset()
        for (const [name, { core }] of self._service.blobsCores) {
          this.set({ core_name: name }, core.peers.length)
        }
      }
    })

    // eslint-disable-next-line no-new
    new promClient.Gauge({
      name: 'qvac_registry_blob_core_fully_downloaded',
      help: 'Whether each blob core is fully downloaded (1=yes, 0=no)',
      labelNames: ['core_name'],
      collect () {
        this.reset()
        for (const [name, { core }] of self._service.blobsCores) {
          const full = core.contiguousLength === core.length && core.length > 0 ? 1 : 0
          this.set({ core_name: name }, full)
        }
      }
    })

    // eslint-disable-next-line no-new
    new promClient.Gauge({
      name: 'qvac_registry_view_core_length',
      help: 'View core length (total blocks)',
      collect () {
        const viewCore = self._service.view?.core
        this.set(viewCore ? viewCore.length : 0)
      }
    })

    // eslint-disable-next-line no-new
    new promClient.Gauge({
      name: 'qvac_registry_view_core_contiguous_length',
      help: 'View core contiguous length (gap = length - contiguous indicates replication lag)',
      collect () {
        const viewCore = self._service.view?.core
        this.set(viewCore ? viewCore.contiguousLength : 0)
      }
    })

    // eslint-disable-next-line no-new
    new promClient.Gauge({
      name: 'qvac_registry_is_indexer',
      help: 'Whether this node is an indexer (1=yes, 0=no)',
      collect () {
        this.set(self._service.base?.isIndexer ? 1 : 0)
      }
    })

    // eslint-disable-next-line no-new
    new promClient.Gauge({
      name: 'qvac_registry_blind_peers_connected',
      help: 'Number of configured blind peers with an active connection',
      collect () {
        this.set(self._service.getConnectedBlindPeerKeys().length)
      }
    })

    // eslint-disable-next-line no-new
    new promClient.Gauge({
      name: 'qvac_registry_blind_peer_connected',
      help: 'Whether each configured blind peer currently has an active connection (1=yes, 0=no)',
      labelNames: ['peer_key'],
      collect () {
        this.reset()
        for (const peerKey of self._service.getConfiguredBlindPeerKeys()) {
          this.set(
            { peer_key: peerKey },
            self._service.isBlindPeerConnected(peerKey) ? 1 : 0
          )
        }
      }
    })

    // eslint-disable-next-line no-new
    new promClient.Gauge({
      name: 'qvac_registry_blob_core_byte_length',
      help: 'Byte length of each blob core',
      labelNames: ['core_name'],
      collect () {
        this.reset()
        for (const [name, { core }] of self._service.blobsCores) {
          this.set({ core_name: name }, core.byteLength)
        }
      }
    })

    // eslint-disable-next-line no-new
    new promClient.Gauge({
      name: 'qvac_registry_model_size_bytes',
      help: 'Size in bytes of each model blob',
      labelNames: ['path', 'engine', 'quantization'],
      async collect () {
        const models = await self._getCachedModels()
        this.reset()
        for (const m of models) {
          if (m.blobBinding && m.blobBinding.byteLength > 0) {
            this.set({
              path: m.path,
              engine: m.engine || '',
              quantization: m.quantization || ''
            }, m.blobBinding.byteLength)
          }
        }
      }
    })
  }

  async _getCachedModels () {
    const now = Date.now()
    if (this._modelCache && now < this._modelCacheExpiry) {
      return this._modelCache
    }

    try {
      const view = this._service.view
      if (!view || !view.opened) return this._modelCache || []
      const models = await view.findModelsByPath({}).toArray()
      this._modelCache = models
      this._modelCacheExpiry = now + MODEL_CACHE_TTL_MS
      return models
    } catch (err) {
      this._logger.warn({ err: err.message }, 'QvacMetrics: failed to query models')
      return this._modelCache || []
    }
  }
}

module.exports = QvacMetrics
