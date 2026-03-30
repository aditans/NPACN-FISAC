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
    <div className="bg-[#071024] p-3 rounded">
      <div className="font-semibold mb-2">Polls Summary</div>
      <div className="flex items-center gap-2 mb-2">
        <button className="px-2 py-1 bg-blue-600 rounded text-sm" onClick={() => setShowCreate(!showCreate)}>{showCreate ? 'Cancel' : 'Create Poll'}</button>
      </div>
      {showCreate && (
        <div className="bg-[#062233] p-2 rounded mb-2">
          <input placeholder="Question" value={newQuestion} onChange={e => setNewQuestion(e.target.value)} className="w-full p-2 mb-2 bg-gray-800" />
          <input placeholder="Choices (comma separated)" value={newChoices} onChange={e => setNewChoices(e.target.value)} className="w-full p-2 mb-2 bg-gray-800" />
          <div className="flex gap-2">
            <button className="px-3 py-1 bg-green-600 rounded" onClick={createPoll}>Create</button>
          </div>
        </div>
      )}
      <div className="text-sm text-gray-400 mb-2">Total polls: {polls.length}</div>
      {polls.map(p => (
        <div key={p.id} className="mb-3">
          <div className="font-medium">{p.question}</div>
          <div className="text-sm text-gray-400">Counts:</div>
          <ul className="text-sm ml-4">
            {Object.keys(p.counts || {}).map(k => (
              <li key={k}>{k}: {p.counts[k]}</li>
            ))}
          </ul>
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
  if (!votes.length) return <div className="text-sm text-gray-500">No votes yet</div>
  return (
    <div className="text-sm mt-2">
      <div className="font-semibold">Voters</div>
      <ul className="ml-4 text-xs text-gray-300">
        {votes.map(v => (
          <li key={v.userId + v.createdAt}>{v.userId} → {v.choiceId}</li>
        ))}
      </ul>
    </div>
  )
}
