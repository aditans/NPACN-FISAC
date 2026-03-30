import React, { useEffect, useState } from 'react'
import API_BASE from '../apiBase'

export default function PollSummary({ logs = [] }) {
  const [polls, setPolls] = useState([])
  const [showCreate, setShowCreate] = useState(false)
  const [newQuestion, setNewQuestion] = useState('')
  const [newChoices, setNewChoices] = useState('')

  function refresh() {
    fetch(`${API_BASE}/polls`)
      .then(r => r.json())
      .then(j => setPolls(j.polls || []))
      .catch(() => {})
  }

  useEffect(() => { refresh() }, [])

  function createPoll() {
    const choices = newChoices.split(',').map(s => s.trim()).filter(Boolean)
    if (!newQuestion || choices.length < 2) { alert('Enter question and at least two choices'); return }
    fetch(`${API_BASE}/polls`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: newQuestion, choices }) })
      .then(r => r.json()).then(j => {
        if (j.ok) {
          setNewQuestion(''); setNewChoices(''); setShowCreate(false); refresh()
        } else {
          alert(j.error || 'create failed')
        }
      }).catch(() => alert('create error'))
  }

  // listen for POLL_UPDATE or LOG VOTE events to refresh summary
  useEffect(() => {
    const last = logs.slice(-100)
    let should = false
    last.forEach(l => {
      if (l.type === 'POLL_UPDATE' || (l.type === 'LOG' && l.subtype === 'VOTE')) should = true
    })
    if (should) refresh()
  }, [logs])

  return (
    <div className="bg-[#071024] border border-gray-800 p-3 rounded h-full">
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="font-semibold">Polls Summary</div>
          <div className="text-xs text-gray-400">Monitor votes and create new polls.</div>
        </div>
        <button className="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-sm" onClick={() => setShowCreate(!showCreate)}>{showCreate ? 'Cancel' : 'Create Poll'}</button>
      </div>
      {showCreate && (
        <div className="bg-[#062233] border border-cyan-900/60 p-2 rounded mb-2">
          <input placeholder="Question" value={newQuestion} onChange={e => setNewQuestion(e.target.value)} className="w-full p-2 mb-2 bg-gray-900 border border-gray-700 rounded" />
          <input placeholder="Choices (comma separated)" value={newChoices} onChange={e => setNewChoices(e.target.value)} className="w-full p-2 mb-2 bg-gray-900 border border-gray-700 rounded" />
          <div className="flex gap-2">
            <button className="px-3 py-1 bg-green-600 hover:bg-green-500 rounded" onClick={createPoll}>Create</button>
          </div>
        </div>
      )}

      <div className="text-xs text-gray-400 mb-2">Total polls: {polls.length}</div>

      {!polls.length && <div className="text-sm text-gray-500 rounded border border-dashed border-gray-700 p-3">No polls created yet.</div>}

      {polls.map(p => (
        <div key={p.id} className="mb-3 rounded bg-[#0b1220] border border-gray-800 p-3">
          <div className="font-medium mb-2">{p.question}</div>
          <div className="space-y-2">
            {(p.choices || []).map(choice => {
              const totalVotes = Object.values(p.counts || {}).reduce((a, b) => a + (b || 0), 0)
              const count = (p.counts && p.counts[choice.id]) || 0
              const pct = totalVotes ? Math.round((count / totalVotes) * 100) : 0
              return (
                <div key={choice.id}>
                  <div className="flex items-center justify-between text-sm">
                    <span>{choice.label}</span>
                    <span className="text-gray-400">{count} ({pct}%)</span>
                  </div>
                  <div className="mt-1 h-2 rounded bg-gray-800 overflow-hidden">
                    <div className="h-full bg-cyan-500" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              )
            })}
          </div>
          <FetchVotes pollId={p.id} />
        </div>
      ))}
    </div>
  )
}

function FetchVotes({ pollId }) {
  const [votes, setVotes] = useState([])
  useEffect(() => {
    fetch(`${API_BASE}/polls/${pollId}/votes`).then(r => r.json()).then(j => { if (j.ok) setVotes(j.votes || []) }).catch(() => {})
  }, [pollId])
  if (!votes.length) return <div className="text-xs text-gray-500 mt-2">No votes yet</div>
  return (
    <div className="text-sm mt-3">
      <div className="font-semibold text-xs uppercase tracking-wide text-gray-400">Voters</div>
      <ul className="ml-4 text-xs text-gray-300 mt-1">
        {votes.map(v => (
          <li key={v.userId + v.createdAt}>{v.userId} → {v.choiceId}</li>
        ))}
      </ul>
    </div>
  )
}
