import React from 'react'
import TerminalLog from './TerminalLog'
import ConnectionTable from './ConnectionTable'
import PollSummary from './PollSummary'

export default function ServerDashboard({ logs, clients, onSend }) {
  return (
    <div className="flex flex-col gap-3">
      <TerminalLog logs={logs} />
      <div className="grid grid-cols-2 gap-3">
        <ConnectionTable clients={clients} onSend={onSend} />
        <PollSummary />
      </div>
    </div>
  )
}
