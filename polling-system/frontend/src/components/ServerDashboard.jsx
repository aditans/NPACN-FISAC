import React from 'react'
import TerminalLog from './TerminalLog'
import ConnectionTable from './ConnectionTable'
import PollSummary from './PollSummary'

export default function ServerDashboard({ logs, clients, onSend, onRefresh }) {
  return (
    <div className="flex flex-col gap-4 rounded border border-gray-800 bg-[#050b16] p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="text-2xl font-bold">Server Dashboard</div>
          <div className="text-sm text-gray-400">Real-time command center for bridge activity, polls, and client status.</div>
        </div>
        <div className="flex items-center gap-2">
          <button className="px-3 py-1 bg-green-600 hover:bg-green-500 rounded text-sm" onClick={() => {
            const clientId = `client-${Date.now()}`
            window.open(`/client?clientId=${clientId}`, '_blank')
          }}>Open Client Page</button>
          <button className="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-sm" onClick={() => onSend && onSend({ action: 'RAW', data: 'PING' })}>Send PING to all</button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-1">
          <TerminalLog logs={logs} />
        </div>

        <div className="lg:col-span-1">
          <PollSummary logs={logs} />
        </div>

        <div className="lg:col-span-1">
          <ConnectionTable clients={clients} onSend={onSend} onRefresh={onRefresh} />
        </div>
      </div>
    </div>
  )
}
