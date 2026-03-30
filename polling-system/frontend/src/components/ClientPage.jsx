import React, { useEffect } from 'react'
import ClientConsole from './ClientConsole'
import Polls from './Polls'

export default function ClientPage({ clientId, onSend, logs = [] }) {
  useEffect(() => {
    // request bridge to create simulated client when this page loads
    if (onSend && clientId) onSend({ action: 'SIM_CONNECT', clientId })
    // cleanup: optionally disconnect when leaving
    return () => { if (onSend && clientId) onSend({ action: 'SIM_DISCONNECT', clientId }) }
  }, [clientId, onSend])

  const client = { id: clientId }

  return (
    <div className="h-screen p-3">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-lg font-semibold">Client Dashboard — {clientId}</div>
        <a className="text-sm text-gray-400" href="/server">Open Server Dashboard</a>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <ClientConsole client={client} onSend={onSend} logs={logs} />
        </div>
        <div className="col-span-1">
          <div className="bg-[#071024] p-3 rounded">
            <div className="font-semibold mb-2">Live Polls</div>
            <Polls onSend={onSend} logs={logs} userId={clientId} />
          </div>
        </div>
      </div>
    </div>
  )
}
