# Frontend - Socket Visualizer

This folder contains a minimal React + Vite frontend and a Node.js bridge for the C server.

Overview
- `server.js` - Node.js bridge that connects to the C TCP server (default localhost:8080) and exposes a WebSocket at port 3001 to the React UI.
- `src/` - React components (StatusBar, ServerDashboard, TerminalLog, ConnectionTable, ClientPanel, ClientConsole)

Quick start (dev)
1. From `polling-system/frontend` install dependencies:

   npm install

2. Start both the bridge and the Vite dev server (dev mode):

   npm run start

This runs `server.js` (bridge) and the Vite dev server. Then open http://localhost:5173

Notes
- For quick development Tailwind is pulled from CDN in `index.html`. For production you should install and configure Tailwind properly.
- The bridge expects the C server to be running on `localhost:8080` by default. You can override with environment variables:

  C_SERVER_HOST=127.0.0.1 C_SERVER_PORT=8080 BRIDGE_WS_PORT=3001 node server.js

- This is a minimal demo scaffold to visualize server logs and simulate clients. It is intentionally small and editable.
