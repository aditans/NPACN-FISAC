import React, { useEffect, useState } from 'react'

export default function Polls({ onSend, logs }) {
  const [polls, setPolls] = useState([])
  const [userId, setUserId] = useState(() => `user-${Math.floor(Math.random()*10000)}`)

  useEffect(() => {
    fetch(`/polls?userId=${encodeURIComponent(userId)}`)
      .then(r => r.json())
      .then(j => setPolls(j.polls || []))
      .catch(() => {})
  }, [])

  // update polls when POLL_UPDATE arrives in logs
  useEffect(() => {
    const last = logs.slice(-50)
    last.forEach(l => {
      if (l.type === 'POLL_UPDATE') {
        setPolls(prev => prev.map(p => p.id === l.pollId ? { ...p, counts: l.counts } : p))
      }
    })
  }, [logs])

  function vote(pollId, choiceId) {
    fetch(`/polls/${pollId}/vote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, choiceId }) })
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
      <div className="mb-2">Your user id: <input className="ml-2 p-1 bg-gray-800" value={userId} onChange={(e)=>setUserId(e.target.value)} /></div>
      {polls.map(p => (
        <div key={p.id} className="bg-[#0b1220] p-3 rounded">
          <div className="font-semibold mb-2">{p.question}</div>
          <div className="grid grid-cols-1 gap-2">
              {p.choices.map(c => (
                <div key={c.id} className="flex items-center justify-between">
                  <div>{c.label}</div>
                  <div className="flex items-center gap-2">
                    <div className="text-sm text-gray-400">{(p.counts && p.counts[c.id]) || 0}</div>
                    <button
                      className="px-2 py-1 bg-blue-600 rounded text-sm"
                      onClick={() => vote(p.id, c.id)}
                      disabled={!!p.userVote}
                      title={p.userVote ? `You voted: ${p.userVote}` : 'Vote'}
                    >
                      {p.userVote ? 'Voted' : 'Vote'}
                    </button>
                  </div>
                </div>
              ))}
          </div>
        </div>
      ))}
    </div>
  )
}
