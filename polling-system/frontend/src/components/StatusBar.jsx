import React, { useEffect, useState } from 'react'

export default function StatusBar({ status }) {
  const [uptime, setUptime] = useState('00:00:00')

  useEffect(() => {
    const t = setInterval(() => {
      const elapsed = Math.floor((Date.now() - (status.uptimeStart || Date.now())) / 1000)
      const h = String(Math.floor(elapsed / 3600)).padStart(2, '0')
      const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0')
      const s = String(elapsed % 60).padStart(2, '0')
      setUptime(`${h}:${m}:${s}`)
    }, 1000)
    return () => clearInterval(t)
  }, [status.uptimeStart])

  return (
    <div className="flex items-center justify-between bg-[#111827] p-3 rounded">
      <div className="flex items-center gap-3">
        <div className="font-bold text-lg">🔌 Socket Visualizer</div>
        <div className="px-2 py-1 bg-green-700 text-sm rounded">{status.running ? 'RUNNING' : 'STOPPED'}</div>
        <div className="text-sm text-gray-300">PORT: {status.port}</div>
      </div>
      <div className="flex items-center gap-4 text-sm text-gray-300">
        <div>⏱ {uptime}</div>
        <div>Connections: {status.totalConnections}</div>
      </div>
    </div>
  )
}
