import React from 'react'
import API_BASE from '../apiBase'
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

          {/* Global testing controls */}
          <button className="px-3 py-1 bg-orange-600 hover:bg-orange-500 rounded text-sm" onClick={async () => {
            const pollId = window.prompt('Poll ID to target (default: poll-1)', 'poll-1') || 'poll-1'
            const choiceId = window.prompt('Choice ID to vote for (e.g. c)', 'c')
            if (!choiceId) return
            const count = parseInt(window.prompt('Number of votes to attempt', '100'), 10) || 100
            const delayMs = parseInt(window.prompt('Delay between votes (ms)', '5'), 10) || 5
            const unique = window.confirm('Use unique simulated clients per vote? (OK = yes)')
            try {
              const res = await fetch(`${API_BASE}/simulate/burst`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pollId, choiceId, count, delayMs, uniqueClients: unique }) })
              const j = await res.json()
              alert('Burst started: ' + (j && j.attempted ? `${j.attempted} votes` : JSON.stringify(j)))
            } catch (e) {
              alert('Burst request failed: ' + e.message)
            }
          }}>Trigger Rapid Burst</button>

          <button className="px-3 py-1 bg-red-700 hover:bg-red-600 rounded text-sm" onClick={async () => {
            if (!window.confirm('Disconnect ALL simulated clients abruptly? This will tear down sockets immediately.')) return
            try {
              const cl = await fetch(`${API_BASE}/clients`).then(r => r.json())
              const clients = (cl && Array.isArray(cl.clients)) ? cl.clients : []
              await Promise.all(clients.map(id => fetch(`${API_BASE}/client/${encodeURIComponent(id)}/disconnect?abrupt=1`, { method: 'POST' })))
              alert(`Requested abrupt disconnect for ${clients.length} clients`)
            } catch (e) {
              alert('Disconnect-all failed: ' + e.message)
            }
          }}>Disconnect All (abrupt)</button>
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
