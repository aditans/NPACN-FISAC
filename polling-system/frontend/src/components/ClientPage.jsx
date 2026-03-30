import React, { useEffect, useRef, useState } from 'react'
import API_BASE from '../apiBase'
import ClientConsole from './ClientConsole'
import Polls from './Polls'
import TerminalLog from './TerminalLog'

export default function ClientPage({ clientId, onSend, logs = [], wsReady = false, clientState = null, onRefresh = null }) {
  const [createStatus, setCreateStatus] = useState('')
  const [showTerminal, setShowTerminal] = useState(true)
  const [voters, setVoters] = useState([])
  const [selectedVoter, setSelectedVoter] = useState(clientId || 'anon')
  const sendRef = useRef(onSend)
  const connectedOnceRef = useRef(false)
  const isConnected = clientState?.status === 'connected'

  useEffect(() => {
    sendRef.current = onSend
  }, [onSend])

  // Load recent voters for the default poll to populate the dropdown
  useEffect(() => {
    let mounted = true
    async function fetchVoters() {
      try {
        const res = await fetch(`${API_BASE}/polls/poll-1/votes`)
        const j = await res.json()
        if (!mounted) return
        if (j && j.ok && Array.isArray(j.votes)) {
          const ids = j.votes.map(v => v.userId).filter(Boolean)
          // include clientId as a top option
          const uniqueIds = Array.from(new Set([clientId || 'anon', ...ids]))
          setVoters(uniqueIds)
          if (!selectedVoter) setSelectedVoter(uniqueIds[0])
        }
      } catch (e) {
        // ignore
      }
    }
    fetchVoters()
    const iv = setInterval(fetchVoters, 5000)
    return () => { mounted = false; clearInterval(iv) }
  }, [clientId])

  useEffect(() => {
    // request bridge to create simulated client once WS is actually ready
    if (!wsReady || !clientId || connectedOnceRef.current) return
    if (sendRef.current) {
      sendRef.current({ action: 'SIM_CONNECT', clientId })
      connectedOnceRef.current = true
    }
  }, [clientId, wsReady])

  useEffect(() => {
    // cleanup: optionally disconnect when leaving
    return () => { if (sendRef.current && clientId) sendRef.current({ action: 'SIM_DISCONNECT', clientId }) }
  }, [clientId])

  function handleConnectToggle() {
    if (!sendRef.current || !clientId) return
    if (isConnected) {
      sendRef.current({ action: 'SIM_DISCONNECT', clientId })
      return
    }
    sendRef.current({ action: 'SIM_CONNECT', clientId })
    connectedOnceRef.current = true
  }

  function handleReconnect() {
    if (!sendRef.current || !clientId) return
    sendRef.current({ action: 'SIM_DISCONNECT', clientId })
    setTimeout(() => {
      if (sendRef.current) {
        sendRef.current({ action: 'SIM_CONNECT', clientId })
        connectedOnceRef.current = true
      }
    }, 150)
  }

  const client = { id: clientId }

  // Debug: surface key props so we can confirm this component is the up-to-date build in the browser
  useEffect(() => {
    try {
      // eslint-disable-next-line no-console
      console.log('[ClientPage] props', { clientId, wsReady, clientState, logsLength: (logs || []).length })
    } catch (e) {}
  }, [clientId, wsReady, clientState, logs])

  return (
    <div className="h-screen p-4 bg-[#030712]">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <div className="text-xl font-semibold">Client Dashboard — {clientId}</div>
          <div className="text-xs text-gray-400">Interactive command-line client with live polls and activity stream.</div>
        </div>
        <div className="flex items-center gap-3">
          {/* Voter selector for manual actions / bursts */}
          <select value={selectedVoter} onChange={(e) => setSelectedVoter(e.target.value)} className="bg-gray-800 text-sm text-gray-200 px-2 py-1 rounded">
            {(voters && voters.length ? voters : ['anon']).map(v => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
          <span className={`text-xs px-2 py-1 rounded ${isConnected ? 'bg-green-900 text-green-300' : 'bg-gray-800 text-gray-300'}`}>
            {isConnected ? 'Connected' : 'Disconnected'}
          </span>
          <button className="px-3 py-1 rounded text-sm bg-sky-700 hover:bg-sky-600" onClick={() => { setShowTerminal(s => !s); if (!showTerminal) setTimeout(() => { const el = document.getElementById('client-terminal-panel'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 80) }}>{showTerminal ? 'Hide Activity' : 'Open Activity Terminal'}</button>
          <button
            className={`px-3 py-1 rounded text-sm ${createStatus === 'registering' ? 'bg-gray-500 cursor-not-allowed' : 'bg-slate-700 hover:bg-slate-600'}`}
            onClick={async () => {
              if (!clientId || createStatus === 'registering') return
              setCreateStatus('registering')
              try {
                const res = await fetch(`${API_BASE}/client`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId }) })
                const j = await res.json()
                if (j && j.ok) {
                  setCreateStatus('registered')
                  try { onRefresh && onRefresh() } catch (e) {}
                } else {
                  setCreateStatus('error')
                }
              } catch (e) {
                setCreateStatus('error')
              }
              setTimeout(() => setCreateStatus(''), 2000)
            }}
            disabled={createStatus === 'registering'}
          >
            {createStatus === 'registering' ? (
              <span className="flex items-center gap-2">
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path></svg>
                Registering...
              </span>
            ) : 'Register client'}
          </button>
          {createStatus ? <span className="text-xs text-gray-300">{createStatus}</span> : null}
          <button
            className={`px-3 py-1 rounded text-sm ${isConnected ? 'bg-red-600 hover:bg-red-500' : 'bg-green-600 hover:bg-green-500'} ${!wsReady ? 'opacity-60 cursor-not-allowed' : ''}`}
            onClick={handleConnectToggle}
            disabled={!wsReady}
          >
            {isConnected ? 'Disconnect from Server' : 'Connect to Server'}
          </button>
          <button
            className={`px-3 py-1 rounded text-sm bg-red-500 hover:bg-red-400 ${!clientId ? 'opacity-60 cursor-not-allowed' : ''}`}
            onClick={async () => {
              if (!clientId) return;
              try {
                // graceful disconnect via bridge API
                await fetch(`${API_BASE}/client/${encodeURIComponent(clientId)}/disconnect`, { method: 'POST' });
                try { onRefresh && onRefresh() } catch (e) {}
              } catch (e) {
                console.error('graceful disconnect error', e);
              }
            }}
            title="Request graceful disconnect of the simulated client (sends FIN/close_notify)">
            Disconnect from Server
          </button>
          <button
            className={`px-3 py-1 rounded text-sm bg-red-700 hover:bg-red-600 ${!clientId ? 'opacity-60 cursor-not-allowed' : ''}`}
            onClick={async () => {
              if (!clientId) return;
              try {
                await fetch(`${API_BASE}/client/${encodeURIComponent(clientId)}/disconnect?abrupt=1`, { method: 'POST' });
                try { onRefresh && onRefresh() } catch (e) {}
              } catch (e) {
                console.error('abrupt disconnect error', e);
              }
            }}
            title="Abruptly tear down the simulated client TCP/TLS socket"
          >
            Abrupt Disconnect
          </button>
          <button
            className={`px-3 py-1 rounded text-sm bg-violet-600 hover:bg-violet-500 ${!clientId ? 'opacity-60 cursor-not-allowed' : ''}`}
            onClick={async () => {
              if (!clientId) return;
              const countStr = window.prompt('How many votes to send in burst? (e.g. 50)', '50');
              if (!countStr) return;
              const count = parseInt(countStr, 10) || 50;
              const delayStr = window.prompt('Delay between votes (ms)', '10');
              const delayMs = parseInt(delayStr, 10) || 10;
              const unique = window.confirm('Use unique simulated clients for each vote? (OK = yes)');
              try {
                const res = await fetch(`${API_BASE}/simulate/burst`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ clientId: unique ? clientId : (selectedVoter || clientId), pollId: 'poll-1', choiceId: 'c', count, delayMs, uniqueClients: unique })
                });
                const j = await res.json();
                console.log('burst result', j);
                try { onRefresh && onRefresh() } catch (e) {}
              } catch (e) {
                console.error('burst error', e);
              }
            }}
            title="Trigger rapid voting burst (use unique clients to bypass per-user vote constraints)">
            Rapid Vote Burst
          </button>
          <button
            className={`px-3 py-1 rounded text-sm bg-amber-600 hover:bg-amber-500 ${!wsReady ? 'opacity-60 cursor-not-allowed' : ''}`}
            onClick={handleReconnect}
            disabled={!wsReady}
          >
            Reconnect
          </button>
          <a className="text-sm text-gray-400" href="/server">Open Server Dashboard</a>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 h-[calc(100vh-96px)]">
        <div className="lg:col-span-2 flex flex-col rounded border border-gray-800 bg-[#050b16] p-3 shadow-[0_0_0_1px_rgba(56,189,248,0.08)]">
          <ClientConsole client={client} onSend={onSend} logs={logs} connectedOverride={clientState?.status === 'connected'} />
        </div>

        <div className="lg:col-span-1 flex flex-col gap-4">
          <div className="bg-[#071024] border border-gray-800 p-3 rounded shadow-[0_0_0_1px_rgba(56,189,248,0.06)]">

            {/* Full-width terminal panel for guaranteed visibility */}
            {showTerminal ? (
              <div id="client-terminal-panel" className="mt-3">
                <TerminalLog logs={logs.filter(l => !l.clientId || l.clientId === clientId)} />
              </div>
            ) : null}
            <div className="font-semibold mb-2">Live Polls</div>
            <Polls onSend={onSend} logs={logs} userId={clientId} />
          </div>

          <div className="bg-[#071024] border border-gray-800 p-3 rounded flex-1 flex flex-col shadow-[0_0_0_1px_rgba(56,189,248,0.06)]">
            <div className="font-semibold mb-2">Activity Log</div>
            <div className="flex-1">
              <TerminalLog logs={logs.filter(l => !l.clientId || l.clientId === clientId)} />
            </div>
          </div>
        </div>
      </div>
      {/* Floating toggle in case header button is not visible for some screens */}
      <div className="fixed right-4 bottom-4 z-50">
        <button onClick={() => setShowTerminal(s => !s)} className="px-3 py-2 bg-sky-600 hover:bg-sky-500 text-sm rounded shadow-lg">{showTerminal ? 'Hide Activity' : 'Open Activity Terminal'}</button>
      </div>
    </div>
  )
}
