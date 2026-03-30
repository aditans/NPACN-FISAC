import React, { useState, useEffect } from 'react'
import API_BASE from '../apiBase'
import TerminalLog from './TerminalLog'

export default function ClientConsole({ client, onSend, onRemove, logs = [], connectedOverride }) {
  const [connected, setConnected] = useState(false)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const lastLogIndex = React.useRef(0)

  // append incoming DATA_RECEIVED logs for this client
  React.useEffect(() => {
    const newLogs = logs.slice(lastLogIndex.current || 0)
    let added = false
    newLogs.forEach(l => {
      if (l.clientId === client.id && l.type === 'DATA_RECEIVED') {
        setMessages(m => [...m, { from: 'server', text: l.data }])
        added = true
      }
      // show bridge LOG events (like VOTE commands) in the client console
      if (l.type === 'LOG' && l.subtype === 'VOTE' && l.clientId === client.id) {
        setMessages(m => [...m, { from: 'info', text: l.message }])
        added = true
      }
    })
    lastLogIndex.current = logs.length
    if (added) {
      // noop for now; could flash UI
    }
  }, [logs, client.id])

  const isConnected = typeof connectedOverride === 'boolean' ? connectedOverride : connected

  function toggle() {
    if (!isConnected) {
      // request bridge to create simulated client
      onSend({ action: 'SIM_CONNECT', clientId: client.id })
      setMessages(m => [...m, { from: 'info', text: 'Connecting...' }])
      setConnected(true)
    } else {
      onSend({ action: 'SIM_DISCONNECT', clientId: client.id })
      setMessages(m => [...m, { from: 'info', text: 'Disconnecting...' }])
      setConnected(false)
      if (onRemove) onRemove()
    }
  }

  function send() {
    if (!input) return
    setMessages(m => [...m, { from: 'me', text: input }])
    onSend({ action: 'SEND', clientId: client.id, data: input })
    setInput('')
  }

  // Polls for this client (to show in-console voting widget)
  const [polls, setPolls] = useState([])
  useEffect(() => {
    fetch(`${API_BASE}/polls?userId=${encodeURIComponent(client.id)}`)
      .then(r => r.json())
      .then(j => setPolls(j.polls || []))
      .catch(() => {})
  }, [client.id])

  function vote(pollId, choiceId) {
    // send a simulated client message over the bridge socket
    const cmd = `VOTE ${pollId} ${choiceId}`
    onSend({ action: 'SEND', clientId: client.id, data: cmd })
    // append to console
    setMessages(m => [...m, { from: 'me', text: cmd }])
    // call bridge API to register vote (acts as server-side vote)
    fetch(`${API_BASE}/polls/${pollId}/vote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: client.id, choiceId }) })
      .then(r => r.json())
      .then(j => {
        if (!j.ok) {
          setMessages(m => [...m, { from: 'info', text: `vote failed: ${j.error || 'unknown'}` }])
        } else {
          setMessages(m => [...m, { from: 'info', text: `vote registered: ${choiceId}` }])
          // refresh polls
          fetch(`${API_BASE}/polls?userId=${encodeURIComponent(client.id)}`).then(r => r.json()).then(j => setPolls(j.polls || [])).catch(()=>{})
        }
      }).catch(e => setMessages(m => [...m, { from: 'info', text: 'vote network error' }]))
  }

  return (
    <div className="bg-[#111827] p-3 rounded border border-gray-800">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="font-medium">{client.id}</div>
          <div className="text-xs text-gray-400">Command Console</div>
        </div>
        <div className="flex items-center gap-2">
          <div className={`w-3 h-3 rounded-full ${isConnected ? 'bg-green-400' : 'bg-red-400'}`}></div>
          <button className="px-2 py-1 bg-gray-700 rounded text-sm" onClick={toggle}>{isConnected ? 'Disconnect' : 'Connect'}</button>
        </div>
      </div>

      <div className="h-40 overflow-auto bg-black border border-gray-800 p-2 mb-2 text-sm font-mono rounded" style={{ background: '#0d0d0d' }}>
        {messages.map((m, i) => (
          <div key={i} className={m.from === 'me' ? 'text-right text-blue-300' : 'text-left text-gray-300'}>
            {m.from === 'me' ? '$ ' : '› '} {m.text}
          </div>
        ))}
      </div>

      <div className="mb-3 flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Enter command (e.g., PING, VOTE poll-1 go)"
          className="flex-1 bg-gray-900 border border-gray-700 p-2 rounded text-sm font-mono"
        />
        <button onClick={send} className="px-3 py-2 bg-blue-600 hover:bg-blue-500 rounded">Run</button>
      </div>

      {/* Terminal log panel filtered for this client */}
      <div className="mb-2">
        <TerminalLog logs={logs.filter(l => l.clientId === client.id || (l.type === 'LOG' && l.clientId === client.id))} />
      </div>

      {/* Poll widget for this client */}
      <div className="bg-[#0b1220] border border-gray-800 p-2 rounded mb-2 text-sm">
        <div className="font-semibold mb-1">Live Polls</div>
        {polls.length === 0 && <div className="text-gray-400">No polls</div>}
        {polls.map(p => (
          <div key={p.id} className="mb-2 rounded bg-[#0f172a] border border-gray-800 p-2">
            <div className="text-sm mb-2">{p.question}</div>
            <div className="flex gap-2 flex-wrap">
              {p.choices.map(c => (
                <button key={c.id} disabled={!!p.userVote} onClick={() => vote(p.id, c.id)} className="px-2 py-1 bg-blue-600 hover:bg-blue-500 rounded text-xs disabled:opacity-50">{p.userVote === c.id ? 'Voted' : c.label}</button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
