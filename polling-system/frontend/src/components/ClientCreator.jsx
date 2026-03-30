import React, { useState } from 'react'

export default function ClientCreator({ onOpen, onCreate }) {
  const [id, setId] = useState(`client-${Date.now()}`)
  const [creating, setCreating] = useState(false)

  function gen() {
    setId(`client-${Date.now()}`)
  }

  async function handleCreate() {
    if (!onCreate) return
    try {
      setCreating(true)
      await onCreate(id)
    } catch (e) {
      // ignore; onCreate may handle errors
    } finally {
      setCreating(false)
    }
  }

  return (
    <div>
      <label className="text-xs text-gray-400">Client ID</label>
      <div className="flex gap-2 mt-2">
        <input value={id} onChange={(e) => setId(e.target.value)} className="flex-1 bg-gray-900 border border-gray-700 p-2 rounded text-sm" />
        <button onClick={gen} className="px-2 py-1 bg-gray-700 rounded text-sm">New</button>
      </div>
      <div className="mt-3 flex gap-2">
        <button onClick={() => onOpen && onOpen(id)} className="px-3 py-1 bg-green-600 hover:bg-green-500 rounded text-sm">Open Client Page</button>
        <button onClick={handleCreate} disabled={creating} className={`px-3 py-1 rounded text-sm ${creating ? 'bg-gray-500 cursor-not-allowed' : 'bg-sky-600 hover:bg-sky-500'}`}>
          {creating ? (
            <span className="flex items-center gap-2">
              <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path></svg>
              Registering...
            </span>
          ) : 'Register client'}
        </button>
      </div>
    </div>
  )
}
