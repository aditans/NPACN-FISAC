import React, { useState } from 'react'

import ClientConsole from './ClientConsole'

export default function ClientPanel({ onSend, clients: bridgeClients = {}, logs = [] }) {
  const [localClients, setLocalClients] = useState([])

  function addClient() {
    if (localClients.length >= 10) return
    const id = `client-${Date.now()}`
    // inform bridge to create simulated client socket
    onSend({ action: 'SIM_CONNECT', clientId: id })
    setLocalClients(c => [...c, { id }])
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
        <div className="font-semibold">Bridge-known Clients</div>
        <div className="text-sm text-gray-400">{Object.keys(bridgeClients).length} clients reported by bridge</div>
      </div>
    </div>
  )
}
