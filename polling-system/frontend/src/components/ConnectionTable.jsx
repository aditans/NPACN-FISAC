import React from 'react'

export default function ConnectionTable({ clients, onSend }) {
  const rows = Object.keys(clients).map((k, idx) => ({ id: k, ...clients[k], idx }))
  return (
    <div className="mt-3 bg-[#111827] p-3 rounded">
      <div className="font-semibold mb-2">Connected Clients</div>
      {rows.length === 0 ? (
        <div className="text-gray-400">No clients connected — waiting...</div>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-gray-400">
            <tr><th>#</th><th>Client</th><th>Connected</th><th>Msgs</th><th>Bytes</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id} className="border-t border-gray-800">
                <td className="py-2">{i+1}</td>
                <td>{r.id}</td>
                <td>{r.connectedAt || '-'}</td>
                <td>{r.msgs || 0}</td>
                <td>{r.bytes || 0}</td>
                <td>
                  <button className="px-2 py-1 bg-blue-600 rounded text-xs mr-2" onClick={() => onSend({ action: 'SEND', clientId: r.id, data: 'pong' })}>Send</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
