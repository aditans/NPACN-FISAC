import React, { useRef, useEffect, useState } from 'react'

export default function TerminalLog({ logs }) {
  const ref = useRef(null)
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    if (!paused && ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight
    }
  }, [logs, paused])

  function colorForType(type) {
    switch (type) {
      case 'CLIENT_CONNECTED':
      case 'CONNECT': return 'text-green-400'
      case 'CLIENT_DISCONNECTED':
      case 'DISCONNECT': return 'text-red-400'
      case 'DATA_RECEIVED':
      case 'DATA': return 'text-cyan-300'
      case 'SEND': return 'text-yellow-300'
      case 'SELECT_POLL':
      case 'POLL': return 'text-gray-400'
      case 'SERVER_ERROR':
      case 'ERROR': return 'text-red-600'
      default: return 'text-white'
    }
  }

  return (
    <div className="flex flex-col h-[60vh]">
      <div className="flex items-center justify-between mb-2">
        <input placeholder="Filter logs..." className="bg-gray-800 p-1 rounded text-sm w-2/3" />
        <button className="px-2 py-1 bg-gray-700 rounded text-sm" onClick={() => setPaused(!paused)}>{paused ? 'Resume' : 'Pause'}</button>
      </div>
      <div ref={ref} className="bg-black font-mono text-sm text-gray-100 p-3 rounded overflow-auto flex-1" style={{ background: '#0d0d0d' }}>
        {logs.map((l, idx) => (
          <div key={idx} className={`mb-1 ${colorForType(l.type || l.TYPE)}`}>
            <span className="text-gray-400">[{new Date(l.timestamp || Date.now()).toLocaleTimeString()}]</span>
            <span className="ml-2 font-semibold">[{l.type}]</span>
            <span className="ml-2">{l.message || l.data || JSON.stringify(l)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
