'use strict'

const promClient = require('prom-client')

// RPC methods that the registry service exposes. Pre-initialising counter
// series at zero for each method means `rate()` returns 0 (instead of NaN)
// from the first scrape, so dashboards do not appear empty on a fresh start.
const RPC_METHODS = Object.freeze([
  'add-model',
  'put-license',
  'update-model-metadata',
  'delete-model',
  'ping'
])

class QvacMetrics {
  constructor (service, opts = {}) {
    this._service = service
    this._logger = opts.logger || console

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

    for (const method of RPC_METHODS) {
      this._rpcRequests.inc({ method }, 0)
      this._rpcErrors.inc({ method }, 0)
    }

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
      name: 'qvac_registry_model_count',
      help: 'Number of models in the registry',
      collect () {
        this.set(self._service.modelCount)
      }
    })

    // eslint-disable-next-line no-new
    new promClient.Gauge({
      name: 'qvac_registry_total_blob_bytes',
      help: 'Total bytes across all model blobs (sum of blobBinding.byteLength across view records)',
      collect () {
        this.set(self._service.totalModelBytes)
      }
    })

    // Derived from totalModelBytes via a background refresh; expose staleness so
    // operators can alert when the refresh stalls.
    // eslint-disable-next-line no-new
    new promClient.Gauge({
      name: 'qvac_registry_totals_refreshed_age_seconds',
      help: 'Seconds since qvac_registry_total_blob_bytes and qvac_registry_model_count were last recomputed (-1 if never)',
      collect () {
        const ts = self._service.totalsRefreshedAt
        this.set(ts ? (Date.now() - ts) / 1000 : -1)
      }
    })

    // eslint-disable-next-line no-new
    new promClient.Gauge({
      name: 'qvac_registry_blob_core_count',
      help: 'Number of blob cores opened locally on this node',
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
      name: 'qvac_registry_view_core_seeders',
      help: 'Peers that hold the view core fully and are willing to upload (full replicas available in the swarm)',
      collect () {
        this.set(countSeeders(self._service.view?.core))
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
      help: 'Byte length of each blob core (only populated on nodes that opened the blob core locally)',
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
      name: 'qvac_registry_blob_core_seeders',
      help: 'Peers per blob core that hold it fully and are uploading (full replicas)',
      labelNames: ['core_name'],
      collect () {
        this.reset()
        for (const [name, { core }] of self._service.blobsCores) {
          this.set({ core_name: name }, countSeeders(core))
        }
      }
    })
  }
}

// A peer is a "seeder" for a core when the replication handshake has opened,
// the remote has advertised willingness to upload, and the remote's contiguous
// length covers the core's current length. `remoteContiguousLength` is zero
// until the handshake completes, so the `remoteOpened` check avoids counting
// partially-initialised peers as full replicas.
function countSeeders (core) {
  if (!core || !Array.isArray(core.peers) || core.length === 0) return 0
  let n = 0
  for (const p of core.peers) {
    if (p.remoteOpened && p.remoteUploading && p.remoteContiguousLength >= core.length) n++
  }
  return n
}

module.exports = QvacMetrics
