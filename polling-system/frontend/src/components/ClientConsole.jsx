import React, { useState, useEffect } from 'react'

export default function ClientConsole({ client, onSend, onRemove, logs = [] }) {
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
    })
    lastLogIndex.current = logs.length
    if (added) {
      // noop for now; could flash UI
    }
  }, [logs, client.id])

  function toggle() {
    if (!connected) {
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
    fetch(`/polls?userId=${encodeURIComponent(client.id)}`)
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
    fetch(`/polls/${pollId}/vote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: client.id, choiceId }) })
      .then(r => r.json())
      .then(j => {
        if (!j.ok) {
          setMessages(m => [...m, { from: 'info', text: `vote failed: ${j.error || 'unknown'}` }])
        } else {
          setMessages(m => [...m, { from: 'info', text: `vote registered: ${choiceId}` }])
          // refresh polls
          fetch(`/polls?userId=${encodeURIComponent(client.id)}`).then(r => r.json()).then(j => setPolls(j.polls || [])).catch(()=>{})
        }
      }).catch(e => setMessages(m => [...m, { from: 'info', text: 'vote network error' }]))
  }

  return (
    <div className="bg-[#111827] p-3 rounded">
      <div className="flex items-center justify-between mb-2">
        <div className="font-medium">{client.id}</div>
        <div className="flex items-center gap-2">
          <div className={`w-3 h-3 rounded-full ${connected ? 'bg-green-400' : 'bg-red-400'}`}></div>
          <button className="px-2 py-1 bg-gray-700 rounded text-sm" onClick={toggle}>{connected ? 'Disconnect' : 'Connect'}</button>
        </div>
      </div>

      <div className="h-36 overflow-auto bg-black p-2 mb-2 text-sm font-mono" style={{ background: '#0d0d0d' }}>
        {messages.map((m, i) => (
          <div key={i} className={m.from === 'me' ? 'text-right text-blue-300' : 'text-left text-gray-300'}>{m.text}</div>
        ))}
      </div>

      {/* Poll widget for this client */}
      <div className="bg-[#0b1220] p-2 rounded mb-2 text-sm">
        <div className="font-semibold mb-1">Live Polls</div>
        {polls.length === 0 && <div className="text-gray-400">No polls</div>}
        {polls.map(p => (
          <div key={p.id} className="mb-2">
            <div className="text-sm mb-1">{p.question}</div>
            <div className="flex gap-2">
              {p.choices.map(c => (
                <button key={c.id} disabled={!!p.userVote} onClick={() => vote(p.id, c.id)} className="px-2 py-1 bg-blue-600 rounded text-xs">{p.userVote === c.id ? 'Voted' : c.label}</button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="flex gap-2">
        <input value={input} onChange={(e) => setInput(e.target.value)} className="flex-1 bg-gray-800 p-2 rounded text-sm" />
        <button onClick={send} className="px-3 py-2 bg-blue-600 rounded">Send</button>
      </div>
    </div>
  )
}
