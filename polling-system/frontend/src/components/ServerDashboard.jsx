import React from 'react'
import TerminalLog from './TerminalLog'
import ConnectionTable from './ConnectionTable'
import PollSummary from './PollSummary'

export default function ServerDashboard({ logs, clients, onSend }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="w-2/3"><TerminalLog logs={logs} /></div>
        <div className="w-1/3 flex flex-col items-end">
          <button className="px-2 py-1 bg-green-600 rounded text-sm mb-2" onClick={() => {
            const clientId = `client-${Date.now()}`
            // open a new browser tab with the client dashboard for this client
            window.open(`/client?clientId=${clientId}`, '_blank')
            // the new tab will request the bridge to create the simulated client on mount
          }}>Open Client Page</button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
  <ConnectionTable clients={clients} onSend={onSend} />
  <PollSummary logs={logs} />
      </div>
    </div>
  )
}
