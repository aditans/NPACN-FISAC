import React, { useState, useEffect } from 'react'

import ClientConsole from './ClientConsole'
import TerminalLog from './TerminalLog'

export default function ClientPanel({ onSend, clients: bridgeClients = {}, logs = [] }) {
  const [localClients, setLocalClients] = useState([])

  // When the bridge reports clients connecting, ensure we have a console for them
  // This makes clients created elsewhere (or via ServerDashboard "Open Client Page")
  // appear in the local UI so their logs are visible.
  useEffect(() => {
    const bridgeIds = Object.keys(bridgeClients || {})
    if (bridgeIds.length === 0) return
    setLocalClients((existing) => {
      const existingIds = new Set(existing.map(e => e.id))
      const toAdd = []
      bridgeIds.forEach(id => {
        if (!existingIds.has(id)) toAdd.push({ id, remote: true })
      })
      if (toAdd.length === 0) return existing
      // append new remote clients after existing ones
      return [...existing, ...toAdd]
    })
  }, [bridgeClients])

  function addClient() {
    if (localClients.length >= 10) return
    const id = `client-${Date.now()}`
    // Open a new client page in a separate tab. The client page will
    // automatically request the bridge to create the simulated client on mount.
    // This ensures the new client is visible in its own page and the main
    // dashboard will receive the CLIENT_CONNECTED event and display logs.
    try {
      window.open(`/client?clientId=${id}`, '_blank')
    } catch (e) {
      // Fallback: if popups are blocked, create the client locally instead
      onSend({ action: 'SIM_CONNECT', clientId: id })
      setLocalClients(c => [...c, { id, remote: false }])
    }
  }

  function removeClient(id) {
    onSend({ action: 'SIM_DISCONNECT', clientId: id })
    setLocalClients(c => c.filter(x => x.id !== id))
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="font-semibold">Client Simulator</div>
        <div>
          <button className="px-2 py-1 bg-green-600 rounded text-sm" onClick={addClient}>Add Client</button>
        </div>
      </div>

      <div className="space-y-2">
        {localClients.map(c => (
          <ClientConsole key={c.id} client={c} onSend={onSend} onRemove={() => removeClient(c.id)} logs={logs} />
        ))}
      </div>

      <div className="mt-2">
        <div className="font-semibold">Client Simulator Logs</div>
  <TerminalLog logs={logs.filter(l => localClients.find(x => x.id === l.clientId))} />
      </div>

      <div className="mt-2">
        <div className="font-semibold">Bridge-known Clients</div>
        <div className="text-sm text-gray-400">{Object.keys(bridgeClients).length} clients reported by bridge</div>
      </div>
    </div>
  )
}
