import React, { useEffect, useState, useRef, useCallback } from 'react'
import API_BASE from './apiBase'
import ServerDashboard from './components/ServerDashboard'
import Polls from './components/Polls'
import ClientCreator from './components/ClientCreator'
import TerminalLog from './components/TerminalLog'
import StatusBar from './components/StatusBar'

export default function App() {
  const [logs, setLogs] = useState([])
  const [clients, setClients] = useState({})
  const [status, setStatus] = useState({ running: true, port: 8080, uptimeStart: Date.now(), totalConnections: 0 })
  const [wsReady, setWsReady] = useState(false)
  const wsRef = useRef(null)

  useEffect(() => {
    const ws = new WebSocket('ws://localhost:3001')
    wsRef.current = ws

    ws.addEventListener('open', () => {
      setWsReady(true)
      setLogs((l) => [...l, { type: 'INFO', message: 'Connected to bridge', timestamp: new Date().toISOString() }])
    })

    ws.addEventListener('message', (ev) => {
      try {
        const obj = JSON.parse(ev.data)
        handleBridgeEvent(obj)
      } catch (e) {
        console.error('invalid', e)
      }
    })

    ws.addEventListener('close', () => {
      setWsReady(false)
      setStatus((s) => ({ ...s, running: false }))
    })

    return () => ws.close()
  }, [])

  // expose a manual refresh function to child dashboards so users can force a client-list refresh
  const refreshClients = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/clients`)
      const j = await res.json()
      if (j && Array.isArray(j.clients)) {
        setClients(prev => {
          const next = { ...prev }
          Object.keys(next).forEach(id => { next[id] = { ...(next[id] || { id }), status: 'disconnected' } })
          j.clients.forEach(id => { next[id] = next[id] || { id, msgs: 0, bytes: 0 }; next[id].status = 'connected' })
          return next
        })
      }
    } catch (e) {
      // ignore errors
    }
  }, [])

  const sendToBridge = useCallback((payload) => {
    // optimistic client-side logging and stats so UI updates immediately
    try {
      const ts = new Date().toISOString()
      setLogs((l) => {
        const entry = {
          type: payload && payload.action ? payload.action : 'RAW',
          clientId: payload && payload.clientId,
          message: payload && payload.data ? payload.data : (payload && payload.action ? payload.action : ''),
          timestamp: ts,
          optimistic: true,
        }
        return [...l, entry].slice(-500)
      })
    } catch (e) {}

    // optimistic client stats for SEND actions
    if (payload && payload.action === 'SEND' && payload.clientId) {
      setClients(prev => {
        const next = { ...prev }
        next[payload.clientId] = next[payload.clientId] || { id: payload.clientId, msgs: 0, bytes: 0 }
        next[payload.clientId].msgs = (next[payload.clientId].msgs || 0) + 1
        next[payload.clientId].bytes = (next[payload.clientId].bytes || 0) + (payload.data ? String(payload.data).length : 0)
        next[payload.clientId].status = next[payload.clientId].status || 'connected'
        return next
      })
    }

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload))
    }
  }, [])

  // Poll bridge HTTP API for connected clients as a fallback if WS events are missed
  useEffect(() => {
    let mounted = true
    async function fetchClients() {
      try {
        const res = await fetch(`${API_BASE}/clients`)
        const j = await res.json()
        if (!mounted) return
        if (j && Array.isArray(j.clients)) {
          setClients(prev => {
            const next = { ...prev }
            // mark known clients disconnected first; then promote active ones below
            Object.keys(next).forEach(id => {
              next[id] = { ...(next[id] || { id }), status: 'disconnected' }
            })
            j.clients.forEach(id => {
              next[id] = next[id] || { id, msgs: 0, bytes: 0 }
              next[id].status = 'connected'
            })
            return next
          })
        }
      } catch (e) {
        // ignore polling errors
      }
    }
    fetchClients()
    const iv = setInterval(fetchClients, 3000)
    return () => { mounted = false; clearInterval(iv) }
  }, [])

  function handleBridgeEvent(obj) {
    setLogs((l) => {
      const next = [...l, obj]
      return next.slice(-500)
    })

    // Maintain a clients map with basic stats
    setClients((prev) => {
      const next = { ...prev }
      if (obj.type === 'CLIENT_CONNECTED') {
        next[obj.clientId] = next[obj.clientId] || { id: obj.clientId, msgs: 0, bytes: 0 }
        next[obj.clientId].connectedAt = obj.timestamp
        next[obj.clientId].status = 'connected'
      } else if (obj.type === 'CLIENT_DISCONNECTED') {
        if (next[obj.clientId]) {
          next[obj.clientId].status = 'disconnected'
          next[obj.clientId].disconnectedAt = obj.timestamp
        }
      } else if (obj.type === 'DATA_RECEIVED' && obj.clientId) {
        next[obj.clientId] = next[obj.clientId] || { id: obj.clientId, msgs: 0, bytes: 0 }
        next[obj.clientId].msgs = (next[obj.clientId].msgs || 0) + 1
        next[obj.clientId].bytes = (next[obj.clientId].bytes || 0) + (obj.bytes || (obj.data ? obj.data.length : 0))
      } else if (obj.type === 'SEND' && obj.clientId) {
        next[obj.clientId] = next[obj.clientId] || { id: obj.clientId, msgs: 0, bytes: 0 }
        next[obj.clientId].status = 'connected'
        if (!next[obj.clientId].connectedAt) next[obj.clientId].connectedAt = obj.timestamp || new Date().toISOString()
        next[obj.clientId].msgs = (next[obj.clientId].msgs || 0) + 1
        next[obj.clientId].bytes = (next[obj.clientId].bytes || 0) + (obj.data ? String(obj.data).length : 0)
      } else if (obj.type === 'LOG' && obj.subtype === 'VOTE' && obj.clientId) {
        next[obj.clientId] = next[obj.clientId] || { id: obj.clientId, msgs: 0, bytes: 0 }
        next[obj.clientId].status = 'connected'
        if (!next[obj.clientId].connectedAt) next[obj.clientId].connectedAt = obj.timestamp || new Date().toISOString()
        next[obj.clientId].msgs = (next[obj.clientId].msgs || 0) + 1
      }
      return next
    })

    if (obj.type === 'CLIENT_CONNECTED') {
      setStatus((s) => ({ ...s, totalConnections: s.totalConnections + 1 }))
    }
  }

  // Support simple path-based frontend split without adding a router.
  // - /client -> client-only UI
  // - /server -> server-only UI
  // - default -> both panes
  const path = typeof window !== 'undefined' ? window.location.pathname : '/'

  if (path.startsWith('/client')) {
    // support /client?clientId=... to open a single-client dashboard page
    try {
      const sp = typeof window !== 'undefined' ? new URL(window.location.href).searchParams : null
      const clientId = sp ? sp.get('clientId') : null
      if (clientId) {
        const ClientPage = require('./components/ClientPage').default
        return <ClientPage clientId={clientId} onSend={sendToBridge} logs={logs} wsReady={wsReady} clientState={clients[clientId]} onRefresh={refreshClients} />
      }
    } catch (e) {}
    // generic client landing page (no clientId) — provide controls to create/open client pages
    return (
      <div className="h-screen p-3">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <div className="text-lg font-semibold">Client Simulator</div>
            <div className="text-sm text-gray-400">Create or open a client dashboard (each client gets its own page)</div>
          </div>
          <a className="text-sm text-gray-400" href="/server">Open Server Dashboard</a>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2">
            <Polls onSend={sendToBridge} logs={logs} />
          </div>

          <div className="lg:col-span-1 bg-[#071024] border border-gray-800 p-3 rounded">
            <div className="font-semibold mb-2">Quick Client Actions</div>
            <ClientCreator onOpen={(id) => { window.open(`/client?clientId=${id}`, '_blank') }} onCreate={async (id) => {
              try {
                await fetch(`${API_BASE}/client`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: id }) })
                // refresh authoritative list
                try { refreshClients() } catch (e) {}
              } catch (e) {}
            }} />

            <div className="mt-4">
              <div className="font-semibold mb-2">Activity</div>
              <TerminalLog logs={logs} />
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (path.startsWith('/server')) {
    return (
      <div className="h-screen p-3">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-lg font-semibold">Server Dashboard</div>
          <a className="text-sm text-gray-400" href="/client">Open Client Simulator</a>
        </div>
        <StatusBar status={status} />
        <div className="mt-3">
          <ServerDashboard logs={logs} clients={clients} onSend={sendToBridge} onRefresh={refreshClients} />
        </div>
      </div>
    )
  }

  return (
    <div className="h-screen grid grid-rows-[auto_1fr] gap-2 p-3">
      <StatusBar status={status} />
      <div className="grid grid-cols-3 gap-3 h-full">
        <div className="col-span-3">
          <ServerDashboard logs={logs} clients={clients} onSend={sendToBridge} onRefresh={refreshClients} />
        </div>
      </div>
    </div>
  )
}
