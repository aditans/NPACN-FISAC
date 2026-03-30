import React, { useEffect, useState } from 'react'

export default function PollSummary() {
  const [polls, setPolls] = useState([])

  useEffect(() => {
    fetch('/polls')
      .then(r => r.json())
      .then(j => setPolls(j.polls || []))
      .catch(() => {})
  }, [])

  return (
    <div className="bg-[#071024] p-3 rounded">
      <div className="font-semibold mb-2">Polls Summary</div>
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
    fetch(`/polls/${pollId}/votes`).then(r => r.json()).then(j => { if (j.ok) setVotes(j.votes || []) }).catch(() => {})
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
