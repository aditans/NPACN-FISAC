import React from 'react'

export default function ConnectionTable({ clients, onSend, onRefresh }) {
  const rows = Object.keys(clients).map((k, idx) => ({ id: k, ...clients[k], idx }))
  return (
    <div className="bg-[#111827] p-3 rounded border border-gray-800">
      <div className="flex items-center justify-between mb-2">
        <div className="font-semibold">Connected Clients</div>
        <div className="flex items-center gap-2">
          <div className="text-xs text-gray-400">{rows.filter(r => r.status === 'connected').length} active / {rows.length} known</div>
          <button className="px-2 py-1 bg-gray-700 rounded text-xs" onClick={() => onRefresh && onRefresh()}>Refresh</button>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="text-gray-400">No clients connected — waiting...</div>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-gray-400">
            <tr><th>#</th><th>Client</th><th>Status</th><th>Connected</th><th>Msgs</th><th>Bytes</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id} className="border-t border-gray-800">
                <td className="py-2">{i+1}</td>
                <td>{r.id}</td>
                <td>
                  <span className={`text-xs px-2 py-1 rounded ${r.status === 'connected' ? 'bg-green-900 text-green-300' : 'bg-gray-800 text-gray-300'}`}>
                    {r.status || 'unknown'}
                  </span>
                </td>
                <td>{r.connectedAt || '-'}</td>
                <td>{r.msgs || 0}</td>
                <td>{r.bytes || 0}</td>
                <td>
                  <button className="px-2 py-1 bg-blue-600 rounded text-xs mr-2 disabled:opacity-50" disabled={r.status !== 'connected'} onClick={() => onSend({ action: 'SEND', clientId: r.id, data: 'pong' })}>Send</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
