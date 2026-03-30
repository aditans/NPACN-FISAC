## Secure Web-Based Live Polling System — Report

This REPORT.md documents the design, implementation, testing plan, and evaluation of a secure Web-Based Live Polling System implemented primarily in C (server-side networking) with a Node.js bridge and React frontend used for orchestration and visualization. The focus of this document is the C code in `polling-system/src/*.c` (networking lab scope). The report is organized to answer the listed requirements and to provide a clear experimental plan. Sections are numbered and divided across four contributors (1..4) — each section lists which person is responsible for capturing screenshots and logs where indicated.

---

Contributors: 1, 2, 3, 4

- Person 1: Architecture, TCP lifecycle, WebSocket upgrade, TLS negotiation (sections 1 & 2)
- Person 2: Concurrency model, socket lifecycle, socket options and experimental methodology (sections 3 & 4)
- Person 3: Database integration, persistence, syslog/entrance logging, DB consistency analysis (sections 5 & 6)
- Person 4: Test plan, experiments (load, abnormal disconnects, malformed frames), results analysis and recommendations (sections 7 & 8)

Where screenshots or log extracts are required, the text includes placeholders like: **screenshot required -- <description> (Person N)**. Please capture the indicated screenshot and replace the placeholder when assembling the final PDF or repository deliverable.

## Executive summary

The system implements a concurrent TCP/WebSocket server in C which authenticates clients, accepts votes, stores votes in a persistent backend (SQLite or optionally Azure Cosmos), and broadcasts poll updates to connected clients. The project demonstrates correct TCP socket lifecycle handling (bind/listen/accept, graceful and abrupt closes), WebSocket upgrade handling (including handshake and masking), TLS negotiation (OpenSSL), and a concurrency model based on pthreads with careful locking around shared state.

The Node bridge and frontend provide orchestration and test harnesses for experiments (socket-option trials, rapid vote bursts, and abnormal disconnects). The codebase includes: `polling_server.c`, `polling_websocket.c`, `polling_db.c`, `polling_tls.c`, `polling_util.c`, and `polling_auth.c` which together implement the required functionality.

Key findings (high level):
- Properly configured socket options (SO_REUSEADDR, TCP_NODELAY, tuned buffer sizes) reduce tail latency and make restarts predictable (fewer bind errors). SO_KEEPALIVE tuning helps detect dead peers during long-lived tests but increases background traffic.
- SQLite local persistence provides ACID vote durability for experiments; turning on WAL and setting synchronous=normal provides a good throughput/consistency balance for bursts.
- Abrupt disconnects create many TIME_WAIT entries on the client side and some CLOSE_WAIT on the server if the server doesn't close file descriptors promptly; careful connection cleanup mitigates resource leaks.
- Malformed/replayed frames must be validated at the WebSocket layer; server defends by strict parsing and rejecting invalid frames and by logging suspicious events (rate-limited).

---

## 1. System architecture and mapping to C sources (Person 1)

High-level components (focus on the C server):

- polling_server.c — main server lifecycle, listen socket creation, accept loop, connection management, per-client handler thread creation, socket option application.
- polling_websocket.c — WebSocket upgrade, frame parsing/unmasking, heartbeat/ping handling, framing for outgoing messages.
- polling_tls.c — TLS context initialization and wrappers for send/recv when TLS is enabled (OpenSSL), including accept wrappers.
- polling_db.c — database abstraction: in-memory ledger + optional Cosmos precheck; SQLite fallback code (local persistence). Implements: init, record_vote, check_duplicate_vote, get_vote_count, log_connection, close.
- polling_util.c — helper functions: broadcast updates, poll management, JSON encoding helpers, logging wrappers, socket state handling.
- polling_auth.c — authentication token generation, validation, user mapping and basic credential check routines.

Runtime diagram (logical):

Browser Frontend <-> WebSocket (via bridge) <-> Node bridge (manages simulated clients & API) <-> C polling_server (TCP/TLS listener)

Files of interest in `polling-system/src/`:
- `polling_server.c` — create socket, apply socket options, bind, listen, accept; spawn pthread per client (client handler); coordinate graceful shutdown.
- `polling_websocket.c` — upgrade handshake and frame handling.
- `polling_tls.c` — TLS wrappers and secure transport functions.
- `polling_db.c` — persistent store, uses SQLite when Cosmos unavailable.

Screenshot placeholders:
- **screenshot required -- System process list showing polling_server listening (ss -ltnp) (Person 1)**
- **screenshot required -- polling_server.log tail showing startup and DB init (Person 1)**

## 1.1 Design contract (small)

- Inputs: network connections (TCP/TLS), WebSocket handshake requests, vote messages (JSON or textual VOTE commands), authentication credentials.
- Outputs: confirmation responses, persistent vote records, broadcast messages (POLL_UPDATE), syslog entries, and metrics.
- Error modes: malformed frames, duplicate votes, DB write failures, TLS handshake failures; server must log and recover where possible.

Success criteria: the server accepts valid client connections, persists votes atomically, rejects duplicates/invalid messages, and broadcasts updates to connected clients with low latency under load.

## 2. TCP three-way handshake, WebSocket upgrade, TLS negotiation (Person 1)

2.1 TCP three-way handshake

- Accept flow: server socket created with socket(AF_INET6, SOCK_STREAM) -> setsockopt (SO_REUSEADDR etc.) -> bind([::]:port) -> listen(backlog) -> accept(). On accept(), kernel has completed the SYN, SYN-ACK, ACK sequence and the socket is in ESTABLISHED state.
- Code locations: `polling_server_start()` in `polling_server.c`.

Detailed justification:
- Using kernel accept ensures the server is presented with an already-established connection so the server's per-connection handler can begin reading immediately. Applying `SO_REUSEADDR` allows fast restarts during tests where many sockets are in TIME_WAIT.

2.2 WebSocket upgrade

- The server accepts an HTTP Upgrade handshake for WebSocket: client sends GET with headers including `Sec-WebSocket-Key`. Server computes SHA1(key + magic) and returns base64-encoded `Sec-WebSocket-Accept` header and switches protocol (HTTP 101). `polling_websocket.c` implements the handshake and handshake timeout.
- The server then parses and unmasks frames from clients (following RFC6455). Payload masking/unmasking and opcode checks are performed; invalid frames produce a controlled error response and shutdown of the connection.

Security notes:
- All incoming WebSocket frames are validated for opcode, proper masking for client -> server frames, maximum payload limits, and timeout behavior (ping/pong). Malformed frames are logged and the connection is rejected.

2.3 TLS negotiation

- When TLS is enabled, the server uses OpenSSL through `polling_tls.c` to accept TLS connections on the listening socket (wraps accept). The TLS handshake occurs after TCP accept and completes the secure channel establishment (certificate selection, TLS versions, cipher negotiation). Once TLS is negotiated, the server exchanges WebSocket upgrade over the secure channel.
- Code notes: `polling_tls_init()`, `polling_tls_accept()` provide wrappers; TLS is optional and controlled via build/runtime macros.

Screenshot placeholders:
- **screenshot required -- TLS handshake log lines showing certificate chosen and TLS version (Person 1)**
- **screenshot required -- WebSocket upgrade HTTP request/response captured from logs or tcpdump (Person 1)**

## 3. Concurrency model and connection lifecycle (Person 2)

3.1 Concurrency model

- The server uses a pthread-per-connection model: for each accepted socket the server creates a detached thread (pthread) to run `polling_client_handler()` which services that client. Shared structures (poll list, vote ledger) are protected via pthread mutexes.
- Rationale:
  - Simplicity: easy mapping between a connection and its handler for lab code.
  - Safety: thread-local stack reduces complex event-loop code for an educational lab.
  - Performance: on modern multi-core systems, pthread-per-connection scales well for hundreds to low-thousands of concurrent clients; for ultra-high loads an event loop or thread pool could be considered.

3.2 Connection lifecycle handling

- The server sets socket options before bind/listen and configures per-client options (TCP_NODELAY, SO_KEEPALIVE, buffer sizes) on accepted sockets as needed. When the client disconnects or an error occurs, the server must close the socket and mark client state appropriately to avoid file descriptor leaks.
- The code carefully handles partial send/receive by using wrappers that loop until requested bytes are sent/received or an error occurs. This protects against short writes and partial frames common in TCP.

3.3 Avoiding concurrency races

- Shared state (poll list, vote ledger) is guarded via pthread_mutex_t. Database writes are performed under transactional guarantees (SQLite BEGIN/COMMIT) in `polling_db.c`. The design avoids long-held locks while doing I/O by performing DB operations that require external I/O within minimal critical sections where possible.

Screenshot placeholders:
- **screenshot required -- Thread list (ps -L or pstack) during load (Person 2)**
- **screenshot required -- ss -tanp showing TIME_WAIT/CLOSE_WAIT counts during an abrupt disconnect test (Person 2)**

## 4. Socket options & experimental methodology (Person 2)

4.1 Socket options implemented

- SO_REUSEADDR — set on the listening socket to allow immediate rebinding after restart (in `polling_socket_set_reuse`).
- SO_KEEPALIVE + TCP_KEEPIDLE/TCP_KEEPINTVL/TCP_KEEPCNT — configured to detect dead peers faster than default (in `polling_socket_set_keepalive`).
- TCP_NODELAY — set to disable Nagle's algorithm for low-latency small writes (in `polling_socket_set_nodelay`).
- SO_RCVBUF / SO_SNDBUF — increased to reduce packet drops under bursts (in `polling_socket_set_buffer_sizes`).

4.2 How to experiment (commands and metrics)

Goal: Measure response latency, error rate, DB transaction latency, and resource usage while toggling socket options.

Experimental steps (scriptable):

1. Baseline: start server with default socket options.
2. Burst: run the bridge `/simulate/burst` with a count (e.g., 1000) and measure:
   - End-to-end voting latency (timestamp before sending vote, timestamp in broadcast event)
   - Database commit times (instrumented or measured via sqlite3 profiling)
   - Server CPU/memory
   - Error rate returned by `/simulate/burst` responses
3. Repeat with TCP_NODELAY=0, TCP_NODELAY=1; record differences in mean P95 latencies.
4. Repeat with SO_KEEPALIVE tuned (shorter idle & interval) to observe quicker detection of dead peers under network loss simulation.
5. Repeat with reduced/increased socket buffers to find optimal values for your environment.

Commands (examples):

```bash
# Start the stack (example) - will honor POLLING_DB_PATH and C_SERVER_PORT
POLLING_DB_PATH=/tmp/polling/votes.db C_SERVER_HOST=127.0.0.1 C_SERVER_PORT=8080 \
  BRIDGE_WS_PORT=3001 BRIDGE_API_PORT=3002 FRONTEND_PORT=5173 ./polling-system/scripts/start_all.sh

# Run a medium burst from the bridge API (unique clients)
curl -sS -X POST http://localhost:3002/simulate/burst -H 'Content-Type: application/json' \
  -d '{"pollId":"poll-1","choiceId":"c","count":1000,"delayMs":1,"uniqueClients":true}'

# Collect TCP states during the test
ss -s; ss -tanp | egrep 'TIME_WAIT|CLOSE_WAIT' | wc -l

# Tail server logs for DB commit latency markers (if added)
tail -n 200 logs/polling_server.log
```

4.3 Runtime instrumentation and DB tuning

- For SQLite in the bridge/C fallback, enable WAL mode and set `PRAGMA synchronous = NORMAL` for throughput:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA wal_autocheckpoint = 1000;
```

- Record metrics to a JSON file during experiments (bridge scripts in `polling-system/scripts/` are already prepared to collect some outputs). The run_all_experiments.sh script automates scenarios and aggregates basic results.

Screenshot placeholders:
- **screenshot required -- Experiment runner output directory showing JSON results (Person 2)**

## 5. Database integration, persistence and logging (Person 3)

5.1 DB choices & behavior

- Primary intended backend (production): Azure Cosmos DB (SQL API). The server performs a precheck to verify connectivity. For local labs, `polling_db.c` implements a fallback to SQLite.
- SQLite is used by the bridge and optionally by the C server fallback. The DB schema ensures a unique (pollId,userId) constraint to block duplicate votes.

5.2 ACID & transaction handling

- Vote recording is encapsulated in a transactional sequence: check existence, insert, commit. For SQLite the code uses `BEGIN TRANSACTION` / `COMMIT` and fails with rollback on errors. This ensures that partial writes do not leave inconsistent state. `polling_db_record_vote()` applies duplicate checks before inserts.

5.3 Logging (syslog & local logs)

- Server logs use a logging abstraction (polling_log_info/warning/error) that is wired to syslog or to the `logs/polling_server.log` file when run via scripts. Log entries include structured text with timestamps, client IDs, and event types.
- Important events to log:
  - Connection established/disconnected (peer IP, port)
  - TLS handshake failures
  - Duplicate vote attempts
  - DB errors (sqlite3_errmsg)

Screenshot placeholders:
- **screenshot required -- Example syslog entries for a vote commit and a duplicate-blocked attempt (Person 3)**

## 6. DB consistency analysis under stress and failure modes (Person 3)

6.1 Experimentally verifiable invariants

- No double-counting: For a given (pollId,userId) only one vote should persist. Tests should assert that counts derived from DB `SELECT choiceId,COUNT(1)` match the number of successful vote responses returned by the API.
- Durability: After a successful response, if the process crashes immediately, the vote record should survive (SQLite commit durability assumed under WAL + synchronous settings). We recommend synchronous=NORMAL for a good throughput/durability compromise.

6.2 Negative scenarios and expected behavior

- DB write failure (full disk, permission): server logs an error and returns VOTE_DB_ERROR; server should not crash and must preserve other clients.
- Partial failure during broadcast: If DB commit succeeds but broadcast to clients fails, persistence is the source of truth and broadcast can be retried asynchronously. Logs must record the broadcast failure with correlation ids.

Test case checklist (DB):

- Positive: single client vote -> DB increment + broadcast -> verified in polls endpoint
- Positive: multiple concurrent clients voting for different choices -> DB counts match total
- Negative: same user double-votes -> server responds 403 and DB unchanged
- Negative: intentionally corrupt DB file -> server logs DB errors and returns VOTE_DB_ERROR

## 7. Security & attack scenarios (Person 4)

7.1 Authentication and authorization

- `polling_auth.c` provides token generation and simple credential checks. All vote requests are validated for token or userId. For the lab, tokens are simple; in production use full JWT with proper expiry & signing.

7.2 Replay and malformed frames

- Replay: to prevent replay, server-side de-duplication by (pollId,userId) prevents repeated counts. For stronger anti-replay in production, use signed timestamps / nonces in client messages.
- Malformed frames: the WebSocket parsing code rejects frames not conformant to RFC6455 (wrong mask usage, invalid opcodes, oversized payloads). The server logs and closes the connection when encountering malformed data.

7.3 Rate limiting and DoS mitigation

- The Node bridge has a `/simulate/burst` API for tests. In production this must be gated with authentication and rate limits. For lab experiments, the script is allowed but should be used with caution.

Screenshot placeholders:
- **screenshot required -- Example malformed frame log and server behavior (Person 4)**

## 8. Test plan and experiments (Person 4)

8.1 Test harness and automation

- Use `polling-system/scripts/run_all_experiments.sh` to run small/medium/large scenarios; it restarts the stack, runs bursts, and aggregates JSON outputs. The bridge API `simulate/burst` supports socketOptions, uniqueClients flag, and delayMs.

8.2 Key experiments

1) Baseline throughput and latency
   - 1k unique clients vote once each with delayMs=1
   - Measure: mean latency, P95, error rate, DB commit time

2) TCP_NODELAY effect
   - Repeat baseline with TCP_NODELAY=0 and TCP_NODELAY=1
   - Compare per-vote latency and variance

3) Abrupt vs graceful disconnects
   - Trigger abrupt disconnects for 2k clients and observe server CLOSE_WAIT/TIME_WAIT counts
   - Verify no fd leaks and server keeps responding

4) Malformed frames & replay
   - Send random invalid frames to a subset of simulated clients via the bridge raw API; observe server logs and ensure it declines invalid frames and isolates offending clients.

5) DB durability under crash
   - After committing a batch of votes, kill the server process immediately and restart; verify votes persisted.

8.3 Data collection

- For each experiment capture:
  - logs/polling_server.log and logs/bridge.log (entire run)
  - /tmp/experiment-<ts>.json with counts and errors (script output)
  - TCP statistics: ss -s; ss -tanp | egrep 'TIME_WAIT|CLOSE_WAIT' | sort | uniq -c
  - sqlite3 counts: `SELECT choiceId, COUNT(1) FROM votes GROUP BY choiceId;`

Screenshot placeholders:
- **screenshot required -- Experiment output JSON file listing counts and errors (Person 4)**

## 9. Results analysis guidelines (Person 4)

9.1 Interpreting socket options

- If TCP_NODELAY shows lower P50/P95 latencies but higher packet counts, it confirms the expected trade-off: lower latency, more packets, slightly higher CPU.
- If enabling keepalive with aggressive intervals reduces CLOSE_WAIT times when the client network is flaky, it indicates better dead-peer detection.

9.2 TCP states

- A surge of TIME_WAIT entries is expected on the side initiating closes; CLOSE_WAIT on the server indicates the application did not close the socket after peer FIN — ensure the server calls close() in cleanup.

9.3 DB consistency

- If DB counts equal the number of successful responses reported by the experiment runner, consistency holds. Any mismatch indicates either lost writes or double-counting and requires log correlation (use timestamps and message ids).

## 10. Recommendations and hardening

- Use WAL mode and PRAGMA synchronous = NORMAL for SQLite in experiments to balance throughput and safety. For production, a cloud DB like Cosmos with proper retry/backoff is suggested.
- Add token-based authentication and role-based access to protected bridge APIs (e.g., /simulate/burst).
- Add rate limiting and request size checks for all endpoints and consider using an evented worker pool when scaling beyond thousands of concurrent connections.
- Add log correlation ids (UUID per vote request) to trace DB writes and broadcasts.

## 11. How to reproduce experiments (commands)

1. Build and start the stack (example):

```bash
cd /home/kali/Documents/NPACN-FISAC
POLLING_DB_PATH=/tmp/polling/votes.db C_SERVER_HOST=127.0.0.1 C_SERVER_PORT=8080 \
  BRIDGE_WS_PORT=3001 BRIDGE_API_PORT=3002 FRONTEND_PORT=5173 \
  COSMOS_ENDPOINT="" COSMOS_KEY="" COSMOS_DB_ID="" \
  ./polling-system/scripts/start_all.sh
```

2. Run a burst:

```bash
curl -sS -X POST http://localhost:3002/simulate/burst -H 'Content-Type: application/json' \
  -d '{"pollId":"poll-1","choiceId":"c","count":1000,"delayMs":1,"uniqueClients":true}' > /tmp/experiment-1000.json
```

3. Check DB counts:

```bash
sqlite3 /tmp/polling/votes.db "SELECT choiceId, COUNT(1) FROM votes WHERE pollId='poll-1' GROUP BY choiceId;"
```

4. Capture TCP states during the run:

```bash
ss -s > /tmp/ss-summary.txt
ss -tanp | egrep 'TIME_WAIT|CLOSE_WAIT' | sort | uniq -c > /tmp/ss-states.txt
```

## 12. Test cases matrix (positive & negative)

Include these tests in your test matrix (automated where possible):

- Positive tests:
  - Authenticated user votes once -> success, DB increment.
  - Many concurrent authenticated users -> DB counts match.
  - Client disconnects gracefully -> server cleans fd and no CLOSE_WAIT.

- Negative tests:
  - Duplicate vote attempt -> server returns duplicate error, DB unaffected.
  - Malformed WebSocket frame -> connection closed, event logged.
  - Rapid bursts with uniqueClients=false for same user -> expect blocked duplicates.
  - DB write failure (simulate disk full) -> server returns DB error and remains available for other operations.

## 13. Appendix: File-to-feature mapping (quick)

- `src/polling_server.c` — core server lifecycle, accept loop, socket options.
- `src/polling_websocket.c` — WebSocket upgrade + frame handling.
- `src/polling_tls.c` — OpenSSL TLS accept/send/recv wrappers.
- `src/polling_db.c` — DB backend (Cosmos precheck + SQLite fallback), vote APIs.
- `src/polling_auth.c` — token & auth helpers.

---

Final notes

This document is written to match the codebase in this repository and concentrates on the C code per lab requirements. Replace each **screenshot required -- <desc> (Person N)** placeholder with the appropriate captured image or log excerpt produced while running the experiments. After images are added, the report can be converted to PDF for submission.

If you want, I can:
- Run the full `run_all_experiments.sh` and attach the JSON+CSV outputs and suggested plots.
- Generate a short presentation (slides) summarizing the experiments and recommendations.

Pick the next action and I will run/assemble the artifacts.
