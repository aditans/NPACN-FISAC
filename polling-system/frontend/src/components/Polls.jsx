import React, { useEffect, useState } from 'react'
import API_BASE from '../apiBase'

export default function Polls({ onSend, logs, userId: propUserId }) {
  const [polls, setPolls] = useState([])
  const [userId, setUserId] = useState(() => propUserId || `user-${Math.floor(Math.random()*10000)}`)
  const [showCreate, setShowCreate] = useState(false)
  const [newQuestion, setNewQuestion] = useState('')
  const [newChoices, setNewChoices] = useState('')

  useEffect(() => {
    fetch(`${API_BASE}/polls?userId=${encodeURIComponent(userId)}`)
      .then(r => r.json())
      .then(j => setPolls(j.polls || []))
      .catch(() => {})
  }, [userId])

  // update polls when POLL_UPDATE arrives in logs
  useEffect(() => {
    const last = logs.slice(-50)
    last.forEach(l => {
      if (l.type === 'POLL_UPDATE') {
        setPolls(prev => prev.map(p => p.id === l.pollId ? { ...p, counts: l.counts } : p))
      }
    })
  }, [logs])

  // react to NEW_POLL broadcasts to refresh full list
  useEffect(() => {
    const last = logs.slice(-50)
    last.forEach(l => {
      if (l.type === 'NEW_POLL') {
        // just fetch full list
        fetch(`${API_BASE}/polls?userId=${encodeURIComponent(userId)}`).then(r => r.json()).then(j => setPolls(j.polls || [])).catch(()=>{})
      }
    })
  }, [logs])

  function vote(pollId, choiceId) {
    fetch(`${API_BASE}/polls/${pollId}/vote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, choiceId }) })
      .then(r => r.json())
      .then(j => {
        if (j.ok) {
          // optimistic update already handled via broadcast; reflect immediately
          setPolls(prev => prev.map(p => p.id === pollId ? { ...p, counts: j.poll.counts, userVote: choiceId } : p))
        } else {
          alert(j.error || 'vote failed')
        }
      })
      .catch(e => { console.error(e); alert('vote failed') })
  }

  if (!polls.length) return <div>No polls available</div>

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm text-gray-400">Your user id: <input className="ml-2 p-1 bg-gray-800" value={userId} onChange={(e)=>setUserId(e.target.value)} /></div>
        <div className="flex items-center gap-2">
          <button className="px-2 py-1 bg-green-600 rounded text-sm" onClick={() => {
            const clientId = `client-${Date.now()}`;
            onSend && onSend({ action: 'SIM_CONNECT', clientId });
            alert(`Requested simulated client: ${clientId}`)
          }}>Add cclient</button>
          <button className="px-2 py-1 bg-blue-600 rounded text-sm" onClick={() => setShowCreate(!showCreate)}>{showCreate ? 'Cancel' : 'Create Poll'}</button>
        </div>
      </div>

      {showCreate && (
        <div className="bg-[#082231] p-3 rounded mb-3">
          <div className="mb-2 font-semibold">Create Poll</div>
          <input placeholder="Question" value={newQuestion} onChange={e=>setNewQuestion(e.target.value)} className="w-full p-2 mb-2 bg-gray-800" />
          <input placeholder="Choices (comma separated)" value={newChoices} onChange={e=>setNewChoices(e.target.value)} className="w-full p-2 mb-2 bg-gray-800" />
          <div className="flex gap-2">
            <button className="px-3 py-1 bg-green-600 rounded" onClick={()=>{
              const choices = newChoices.split(',').map(s=>s.trim()).filter(Boolean);
              if (!newQuestion || choices.length < 2) { alert('Enter question and at least two choices'); return }
              fetch(`${API_BASE}/polls`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ question: newQuestion, choices }) })
                .then(r=>r.json()).then(j=>{
                  if (j.ok) { setShowCreate(false); setNewQuestion(''); setNewChoices(''); fetch(`${API_BASE}/polls?userId=${encodeURIComponent(userId)}`).then(r=>r.json()).then(j=>setPolls(j.polls||[])).catch(()=>{}) }
                  else alert(j.error || 'create failed')
                }).catch(()=>alert('create error'))
            }}>Create</button>
          </div>
        </div>
      )}
  <div className="mb-2">Your user id: <input className="ml-2 p-1 bg-gray-800" value={userId} onChange={(e)=>setUserId(e.target.value)} /></div>
      {polls.map(p => (
        <PollRow key={p.id} p={p} vote={vote} />
      ))}
    </div>
  )
}

function PollRow({ p, vote }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="bg-[#0b1220] p-3 rounded">
      <div className="flex items-center justify-between cursor-pointer" onClick={() => setOpen(!open)}>
        <div className="font-semibold">{p.question}</div>
        <div className="text-sm text-gray-400">{Object.values(p.counts || {}).reduce((a,b)=>a+(b||0),0)} votes</div>
      </div>
      {open && (
        <div className="mt-2 grid grid-cols-1 gap-2">
          {p.choices.map(c => (
            <div key={c.id} className="flex items-center justify-between">
              <div>{c.label}</div>
              <div className="flex items-center gap-2">
                <div className="text-sm text-gray-400">{(p.counts && p.counts[c.id]) || 0}</div>
                <button className="px-2 py-1 bg-blue-600 rounded text-sm" onClick={() => vote(p.id, c.id)} disabled={!!p.userVote}>{p.userVote ? 'Voted' : 'Vote'}</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
