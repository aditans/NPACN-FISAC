Create a `/frontend` folder for a Linux TCP socket programming visualizer app.
The app has a C backend (TCP server) and needs a web-based frontend built with
React + Tailwind CSS (single file per component, no separate CSS files).

---

## TECH STACK
- React (Vite)
- Tailwind CSS
- WebSocket (ws library) for real-time communication between C server ↔ Node.js bridge ↔ React UI
- Node.js bridge server (server.js) that:
  - Connects to the C TCP server on localhost:8080
  - Exposes a WebSocket on port 3001 for the React frontend
  - Forwards all server events (connections, disconnections, data received, errors) to the frontend as JSON

---

## FOLDER STRUCTURE to create:

frontend/
├── package.json
├── vite.config.js
├── index.html
├── server.js              ← Node.js WebSocket bridge (connects to C server + feeds UI)
├── src/
│   ├── main.jsx
│   ├── App.jsx            ← Root: two panels side by side (Server Dashboard | Client Panel)
│   ├── components/
│   │   ├── ServerDashboard.jsx     ← Left panel: terminal-style log + connection table
│   │   ├── TerminalLog.jsx         ← Scrolling black terminal with colored log lines
│   │   ├── ConnectionTable.jsx     ← Live table of connected clients
│   │   ├── ClientPanel.jsx         ← Right panel: simulate sending messages as a client
│   │   ├── ClientConsole.jsx       ← Per-client message send/receive console
│   │   └── StatusBar.jsx           ← Top bar: server status, port, uptime, total connections
connections

{ "type": "CLIENT_CONNECTED",   "clientId": "192.168.1.5:54321", "timestamp": "10:42:03" }
  { "type": "DATA_RECEIVED",      "clientId": "192.168.1.5:54321", "data": "hello", "bytes": 5 }
  { "type": "CLIENT_DISCONNECTED","clientId": "192.168.1.5:54321", "timestamp": "10:42:10" }
  { "type": "SERVER_ERROR",       "message": "bind failed",         "timestamp": "10:42:00" }
  { "type": "SERVER_STARTED",     "port": 8080,                     "timestamp": "10:42:00" }
  { "type": "SELECT_POLL",        "activeFds": 3,                   "timestamp": "10:42:05" }

Also allow the frontend to SEND messages to a specific client:

json  { "action": "SEND", "clientId": "192.168.1.5:54321", "data": "pong" }
```

---

### 2. `ServerDashboard.jsx` — Left Panel (60% width)

#### A. `StatusBar` at the top:
- Server status badge: green "RUNNING" / red "STOPPED" / yellow "CONNECTING"
- Port number display: `PORT: 8080`
- Uptime counter (live, counting up from connect time)
- Total connections ever counter
- Active connections counter

#### B. `TerminalLog.jsx` — black terminal window, full height scrollable:
- Background: `#0d0d0d`, font: `monospace`, font-size: 13px
- Auto-scroll to bottom on new entries (with a "pause scroll" toggle button)
- Each log line has a colored prefix based on type:
  - 🟢 `[CONNECT]`    — green  — "Client 192.168.1.5:54321 connected"
  - 🔴 `[DISCONNECT]` — red    — "Client 192.168.1.5:54321 disconnected"
  - 🔵 `[DATA]`       — cyan   — "← 192.168.1.5:54321 sent: 'hello' (5 bytes)"
  - 🟡 `[SEND]`       — yellow — "→ 192.168.1.5:54321 sent: 'pong'"
  - ⚪ `[POLL]`       — gray   — "select() watching 3 fds"
  - 🔴 `[ERROR]`      — bright red — "ERROR: bind failed"
  - ⚪ `[INFO]`       — white  — general server messages
- Each line: `[HH:MM:SS]  [TYPE]  message`
- Max 500 lines in memory (oldest removed)
- Search/filter bar above terminal to filter by type or keyword

#### C. `ConnectionTable.jsx` below or beside terminal:
- Live table of currently connected clients
- Columns: `#` | `Client IP:Port` | `Connected At` | `Duration` | `Msgs Received` | `Bytes In` | `Status` | `Actions`
- `Actions`: "Send Message" button (opens inline input) | "Disconnect" button
- Row highlights green briefly on new data, red on disconnect before removal
- Empty state: "No clients connected — waiting..."

---

### 3. `ClientPanel.jsx` — Right Panel (40% width)

This simulates multiple clients connecting to the server from the browser UI.

#### A. "Add Client" button — creates a new simulated client tab
- Each client gets a tab (like browser tabs) with its assigned ID/color
- Max 5 simultaneous simulated clients

#### B. Per-client `ClientConsole.jsx`:
- Shows a chat-bubble style conversation:
  - Right-aligned blue bubbles = messages this client SENT
  - Left-aligned gray bubbles = messages RECEIVED from server
- Message input box at bottom + "Send" button
- "Connect" / "Disconnect" toggle button per client
- Client status indicator (green dot = connected, red = disconnected)
- Shows client's assigned port number once connected

#### C. Visual connection indicator:
- An animated line/arrow diagram between "Client" box and "Server" box
- Pulses/animates when data flows in either direction

---

### 4. `App.jsx` — Layout
```
┌─────────────────────────────────────────────────────────────────┐
│  🔌 Socket Visualizer       PORT: 8080   ● RUNNING   ⏱ 00:03:22 │  ← StatusBar
├──────────────────────────────────┬──────────────────────────────┤
│  SERVER DASHBOARD                │  CLIENT SIMULATOR            │
│                                  │                              │
│  ┌──────────────────────────┐    │  [Client 1] [Client 2] [+]   │
│  │ $ [10:42:00] [INFO]      │    │                              │
│  │   Server started :8080   │    │  ┌──────────────────────┐   │
│  │ $ [10:42:03] [CONNECT]   │    │  │  ● Client 1 :54321   │   │
│  │   192.168.1.5 connected  │    │  │                        │  │
│  │ $ [10:42:05] [POLL]      │    │  │  Server: "hello!"      │  │
│  │   select() watching 2fds │    │  │         You: "world"   │  │
│  │ $ [10:42:07] [DATA]      │    │  │                        │  │
│  │   ← got: 'world' 5 bytes │    │  │  [type message...][Send]  │
│  │ _                        │    │  └──────────────────────┘   │
│  └──────────────────────────┘    │                              │
│                                  │  [Disconnect] [New Client +] │
│  ┌── CONNECTED CLIENTS ──────┐   │                              │
│  │ # │ IP:Port   │ Duration  │   │                              │
│  │ 1 │ ...:54321 │ 00:01:22  │   │                              │
│  └───────────────────────────┘   │                              │
└──────────────────────────────────┴──────────────────────────────┘

5. STYLING RULES

Dark theme only: background #0f0f0f, panels #1a1a1a, borders #2a2a2a
Terminal uses font-family: 'Courier New', monospace
Status indicators use animated blinking dots (CSS pulse animation)
Tailwind utility classes only — no custom CSS files
Responsive: stacks vertically on screens < 1024px


6. package.json scripts:
json"scripts": {
  "dev": "vite",
  "bridge": "node server.js",
  "start": "concurrently \"npm run bridge\" \"npm run dev\""
}
Dependencies: react, react-dom, vite, @vitejs/plugin-react, ws, concurrently, tailwindcss

7. README.md inside /frontend:
Include:

How to install: npm install
How to run: npm start (starts both bridge + Vite dev server)
How to connect: first run the C server (./server), then npm start
Architecture diagram (ASCII) showing: C Server ↔ Node Bridge ↔ React UI


---

Paste this entire block into Copilot Chat (or as a Copilot Workspace prompt). It's written to be unambiguous — Copilot will generate the full folder structure, all components, the Node bridge, and the layout in one shot. If you want me to just **build it right now** instead, say the word and I'll generate the whole `/frontend` folder for you here.


