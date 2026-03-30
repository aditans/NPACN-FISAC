/*
 * ============================================================================
 * POLLING SYSTEM - SERVER IMPLEMENTATION
 * ============================================================================
 *
 * Implements a TCP/WebSocket-based live polling server with:
 * - TCP three-way handshake analysis and connection lifecycle
 * - WebSocket protocol upgrade with TLS negotiation
 * - Concurrent client handling using pthread
 * - Database persistence (SQLite)
 * - Syslog integration
 * - Socket option configuration (SO_REUSEADDR, SO_KEEPALIVE, TCP_NODELAY)
 * - Real-time result broadcasting
 *
 * Compilation:
 *  gcc -o polling_server polling_server.c polling_websocket.c polling_db.c \
 *      polling_auth.c polling_util.c polling_tls.c -lpthread -lsqlite3 -lssl -lcrypto
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <pthread.h>
#include <signal.h>
#include <errno.h>
#include <syslog.h>
#include <time.h>
#include <fcntl.h>
#include <sys/epoll.h>
#include "../include/polling.h"

/* ============================================================================
 * STATIC VARIABLES & GLOBALS
 * ============================================================================
 */

static polling_server_t* g_server = NULL;
static volatile int g_shutdown = 0;

/* ============================================================================
 * SIGNAL HANDLERS
 * ============================================================================
 */

static void polling_signal_handler(int signum) {
    if (signum == SIGINT || signum == SIGTERM) {
        g_shutdown = 1;
        polling_log_info("Shutdown signal received (%d), initiating graceful shutdown", signum);
        if (g_server) {
            polling_server_stop(g_server);
        }
    }
}

/* ============================================================================
 * TCP THREE-WAY HANDSHAKE & CONNECTION LIFECYCLE ANALYSIS
 * ============================================================================
 *
 * TCP 3-Way Handshake (RFC 793):
 * 
 * CLIENT                           SERVER
 *   |                                |
 *   |------------ SYN(seq=x) ------->| (SYN_SENT → SYN_RCVD)
 *   |                                |
 *   |<------ SYN-ACK(seq=y, ack=x+1) |(SYN_RCVD)
 *   | (SYN_RCVD is transient)        |
 *   |                                |
 *   |------ ACK(seq=x+1, ack=y+1) -->| (ESTABLISHED)
 *   |                                |
 *   (ESTABLISHED after ACK)    (ESTABLISHED after accept())
 *
 * Connection Termination (RFC 793) - 4-Way Handshake:
 *
 * CLOSER                      CLOSER
 *   |                            |
 *   |------ FIN(seq=z) ------->  | (FIN_WAIT_1)
 *   |                            |
 *   |<---- ACK(seq=y+1, ack=z+1)-| (CLOSE_WAIT)
 *   | (FIN_WAIT_2)               |
 *   |                            |
 *   |<----- FIN(seq=w) ---------| (LAST_ACK)
 *   |                            |
 *   |------ ACK(seq=z+1, ack=w+1)| (TIME_WAIT for 2*MSL)
 *   |                            | (CLOSED)
 * (CLOSED after 2*MSL)
 *   
 * TIME_WAIT Purpose:
 * - Ensures delayed packets don't contaminate new connections
 * - Allows reliable connection termination
 * - 2*MSL = typically 60 seconds (Linux default)
 *
 * SO_REUSEADDR allows binding to ports in TIME_WAIT (critical for restarts)
 * SO_KEEPALIVE detects dead connections (idle > 2 hours by default, configurable)
 * TCP_NODELAY disables Nagle's algorithm for immediate small frame transmission
 */

/* ============================================================================
 * SOCKET CONFIGURATION FUNCTIONS
 * ============================================================================
 */

/**
 * polling_socket_set_reuse - Enable SO_REUSEADDR
 *
 * By default, after close(), a socket enters TIME_WAIT state for ~60 seconds.
 * SO_REUSEADDR allows bind() to succeed even if local address is in TIME_WAIT.
 * This is CRITICAL for server restarts to avoid "Address already in use" errors.
 */
int polling_socket_set_reuse(int sockfd) {
    int opt = POLLING_SO_REUSEADDR;
    if (setsockopt(sockfd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt)) < 0) {
        polling_log_error("Failed to set SO_REUSEADDR: %s", strerror(errno));
        return -1;
    }
    polling_log_debug("SO_REUSEADDR enabled on socket %d", sockfd);
    return 0;
}

/**
 * polling_socket_set_keepalive - Enable SO_KEEPALIVE + TCP keepalive options
 *
 * SO_KEEPALIVE enables TCP keepalive probes to detect dead connections.
 * Without this, a connection that drops (e.g., network failure) isn't detected
 * until application tries to send/recv.
 *
 * TCP_KEEP{IDLE,INTVL,CNT} control keepalive behavior (Linux):
 * - TCP_KEEPIDLE: Time before first probe (default 2h, set to 60s)
 * - TCP_KEEPINTVL: Interval between probes (default 75s, set to 10s)
 * - TCP_KEEPCNT: Number of probes before timeout (default 9, set to 5)
 */
int polling_socket_set_keepalive(int sockfd) {
    int opt = POLLING_SO_KEEPALIVE;
    if (setsockopt(sockfd, SOL_SOCKET, SO_KEEPALIVE, &opt, sizeof(opt)) < 0) {
        polling_log_error("Failed to set SO_KEEPALIVE: %s", strerror(errno));
        return -1;
    }

#ifdef TCP_KEEPIDLE
    int keepidle = POLLING_KEEPALIVE_IDLE;
    if (setsockopt(sockfd, IPPROTO_TCP, TCP_KEEPIDLE, &keepidle, sizeof(keepidle)) < 0) {
        polling_log_error("Failed to set TCP_KEEPIDLE: %s", strerror(errno));
        return -1;
    }
#endif

#ifdef TCP_KEEPINTVL
    int keepintvl = POLLING_KEEPALIVE_INTERVAL;
    if (setsockopt(sockfd, IPPROTO_TCP, TCP_KEEPINTVL, &keepintvl, sizeof(keepintvl)) < 0) {
        polling_log_error("Failed to set TCP_KEEPINTVL: %s", strerror(errno));
        return -1;
    }
#endif

#ifdef TCP_KEEPCNT
    int keepcnt = POLLING_KEEPALIVE_COUNT;
    if (setsockopt(sockfd, IPPROTO_TCP, TCP_KEEPCNT, &keepcnt, sizeof(keepcnt)) < 0) {
        polling_log_error("Failed to set TCP_KEEPCNT: %s", strerror(errno));
        return -1;
    }
#endif

    polling_log_debug("SO_KEEPALIVE configured on socket %d (idle=%d, intvl=%d, cnt=%d)",
                      sockfd, POLLING_KEEPALIVE_IDLE, POLLING_KEEPALIVE_INTERVAL,
                      POLLING_KEEPALIVE_COUNT);
    return 0;
}

/**
 * polling_socket_set_nodelay - Enable TCP_NODELAY
 *
 * Disables Nagle's algorithm (RFC 896). By default, TCP waits for ACK of
 * previous segment or builds full MSS before sending small packets.
 * TCP_NODELAY sends immediately, reducing latency (critical for interactive polling).
 *
 * Trade-off: More packets sent, slightly higher overhead, but lower latency.
 */
int polling_socket_set_nodelay(int sockfd) {
    int opt = POLLING_TCP_NODELAY;
    if (setsockopt(sockfd, IPPROTO_TCP, TCP_NODELAY, &opt, sizeof(opt)) < 0) {
        polling_log_error("Failed to set TCP_NODELAY: %s", strerror(errno));
        return -1;
    }
    polling_log_debug("TCP_NODELAY enabled on socket %d", sockfd);
    return 0;
}

/**
 * polling_socket_set_buffer_sizes - Configure SO_RCVBUF and SO_SNDBUF
 *
 * Increases socket buffers to reduce packet loss during traffic spikes.
 * Default is typically 128 KB; we increase to 64 KB for both directions.
 * Larger buffers reduce probability of application-level packet loss.
 */
int polling_socket_set_buffer_sizes(int sockfd) {
    int rcvbuf = POLLING_SO_RCVBUF_SIZE;
    int sndbuf = POLLING_SO_SNDBUF_SIZE;

    if (setsockopt(sockfd, SOL_SOCKET, SO_RCVBUF, &rcvbuf, sizeof(rcvbuf)) < 0) {
        polling_log_error("Failed to set SO_RCVBUF: %s", strerror(errno));
        return -1;
    }

    if (setsockopt(sockfd, SOL_SOCKET, SO_SNDBUF, &sndbuf, sizeof(sndbuf)) < 0) {
        polling_log_error("Failed to set SO_SNDBUF: %s", strerror(errno));
        return -1;
    }

    polling_log_debug("Socket buffers configured: RCV=%d, SND=%d", rcvbuf, sndbuf);
    return 0;
}

/**
 * polling_socket_get_peer_info - Extract peer socket address
 *
 * Uses getpeername() to retrieve connected peer information for logging.
 */
int polling_socket_get_peer_info(int sockfd, struct sockaddr_in6* addr) {
    socklen_t len = sizeof(*addr);
    if (getpeername(sockfd, (struct sockaddr*)addr, &len) < 0) {
        polling_log_error("getpeername failed: %s", strerror(errno));
        return -1;
    }
    return 0;
}

/* ============================================================================
 * SERVER LIFECYCLE - CREATE & DESTROY
 * ============================================================================
 */

/**
 * polling_server_create - Allocate and initialize server structure
 */
polling_server_t* polling_server_create(uint16_t port, int max_clients) {
    polling_server_t* server = calloc(1, sizeof(*server));
    if (!server) {
        perror("calloc");
        return NULL;
    }

    server->port = port;
    server->max_clients = max_clients;
    server->listen_socket = -1;
    server->running = 0;
    server->db_fd = -1;

    /* Allocate client connection pool */
    server->clients = calloc(max_clients, sizeof(client_conn_t));
    if (!server->clients) {
        perror("calloc clients");
        free(server);
        return NULL;
    }

    /* Initialize mutexes and rwlocks */
    pthread_mutex_init(&server->clients_lock, NULL);
    pthread_rwlock_init(&server->polls_lock, NULL);

    /* Allocate poll pool */
    server->polls = calloc(POLLING_MAX_POLLS, sizeof(poll_t));
    if (!server->polls) {
        perror("calloc polls");
        free(server->clients);
        free(server);
        return NULL;
    }

    server->poll_count = 0;
    snprintf(server->db_path, sizeof(server->db_path), "/var/lib/polling/votes.db");

    polling_log_info("Server created: port=%d, max_clients=%d", port, max_clients);
    return server;
}

/**
 * polling_server_destroy - Free all resources
 */
void polling_server_destroy(polling_server_t* server) {
    if (!server) return;

    if (server->listen_socket >= 0) {
        close(server->listen_socket);
    }

    pthread_mutex_destroy(&server->clients_lock);
    pthread_rwlock_destroy(&server->polls_lock);

    for (int i = 0; i < server->max_clients; i++) {
        if (server->clients[i].is_active) {
            polling_client_disconnect(&server->clients[i]);
        }
    }

    free(server->clients);
    free(server->polls);
    polling_db_close(server);
    free(server);

    polling_log_info("Server destroyed");
}

/* ============================================================================
 * SERVER STARTUP - CREATE LISTENING SOCKET
 * ============================================================================
 */

/**
 * polling_server_start - Create passive socket and begin accepting connections
 *
 * This implements the server-side TCP three-way handshake:
 * 1. Create socket (SOCK_STREAM = TCP)
 * 2. Bind to local address + port
 * 3. Listen with backlog queue
 * 4. Accept connections (blocks until SYN received)
 * 5. Fork/thread for each connection
 *
 * On accept(), the kernel has already completed the 3-way handshake:
 * - SYN received from client
 * - SYN-ACK sent by kernel
 * - ACK received from client
 * - Connection is in ESTABLISHED state
 */
int polling_server_start(polling_server_t* server) {
    struct sockaddr_in6 addr;

    if ((server->listen_socket = socket(AF_INET6, SOCK_STREAM, 0)) < 0) {
        polling_log_error("socket(AF_INET6, SOCK_STREAM): %s", strerror(errno));
        return -1;
    }

    polling_log_debug("Socket created: fd=%d", server->listen_socket);

    /* Configure socket options for robustness */
    if (polling_socket_set_reuse(server->listen_socket) < 0) goto error;
    if (polling_socket_set_keepalive(server->listen_socket) < 0) goto error;
    if (polling_socket_set_buffer_sizes(server->listen_socket) < 0) goto error;

    /* Bind to [::]:port (IPv6 with IPv4-mapped addresses) */
    memset(&addr, 0, sizeof(addr));
    addr.sin6_family = AF_INET6;
    addr.sin6_port = htons(server->port);
    addr.sin6_addr = in6addr_any;

    if (bind(server->listen_socket, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
        polling_log_error("bind([::]:/%d): %s", server->port, strerror(errno));
        goto error;
    }

    polling_log_info("Socket bound to [::]:/%d", server->port);

    /* Listen with backlog of 64 (SYN_RCVD queue capacity) */
    if (listen(server->listen_socket, 64) < 0) {
        polling_log_error("listen: %s", strerror(errno));
        goto error;
    }

    server->running = 1;
    polling_log_info("Server listening on port %d", server->port);

    return 0;

error:
    close(server->listen_socket);
    server->listen_socket = -1;
    return -1;
}

/**
 * polling_server_stop - Stop accepting new connections and shut down
 */
void polling_server_stop(polling_server_t* server) {
    if (!server) return;
    server->running = 0;
    polling_log_info("Server stop requested");
}

/* ============================================================================
 * CLIENT CONNECTION HANDLING - CONCURRENT PROCESSING
 * ============================================================================
 */

/**
 * polling_client_handler - Per-client thread function
 *
 * Handles the full client lifecycle:
 * 1. WebSocket upgrade (HTTP GET → 101 Switching Protocols)
 * 2. Authentication (username/password or token)
 * 3. Vote processing (JSON messages)
 * 4. Real-time result broadcasting
 * 5. Connection termination (FIN → FIN_WAIT_1 → CLOSE_WAIT → TIME_WAIT)
 */
void* polling_client_handler(void* arg) {
    client_conn_t* client = (client_conn_t*)arg;
    uint8_t frame_buf[POLLING_BUFFER_SIZE];
    websocket_frame_t frame;
    int bytes_read;
    char peer_ip[INET6_ADDRSTRLEN];

    inet_ntop(AF_INET6, &client->peer_addr.sin6_addr, peer_ip, sizeof(peer_ip));
    polling_log_info("Client handler started for %s:%d (fd=%d)",
                     peer_ip, ntohs(client->peer_addr.sin6_port), client->socket_fd);

    client->connected_at = time(NULL);
    client->state = CLIENT_STATE_CONNECTED;
    client->last_heartbeat = time(NULL);

    /* Main event loop - receive and process messages */
    while (client->is_active && !g_shutdown) {
        memset(frame_buf, 0, sizeof(frame_buf));

        /* Receive data with 5-second timeout */
        struct timeval tv;
        tv.tv_sec = 5;
        tv.tv_usec = 0;
        setsockopt(client->socket_fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

        /* Handle partial receive (RFC 793 - correct handling) */
        bytes_read = recv(client->socket_fd, frame_buf, sizeof(frame_buf), 0);

        if (bytes_read < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK) {
                /* Timeout - check keepalive */
                time_t now = time(NULL);
                if (now - client->last_heartbeat > WEBSOCKET_PING_INTERVAL) {
                    /* Send keepalive PING frame */
                    uint8_t ping_frame[2] = {0x89, 0x00}; /* PING opcode, no payload */
                    if (send(client->socket_fd, ping_frame, sizeof(ping_frame), 0) < 0) {
                        polling_log_warning("Keepalive ping failed for %s:%d",
                                          peer_ip, ntohs(client->peer_addr.sin6_port));
                        break;
                    }
                    client->last_heartbeat = now;
                }
                continue;
            }
            polling_log_error("recv() failed: %s", strerror(errno));
            break;
        }

        if (bytes_read == 0) {
            /* Client initiates FIN (enters FIN_WAIT_1)
             * Server transitions to CLOSE_WAIT, then sends FIN (LAST_ACK)
             * Socket enters TIME_WAIT after final ACK is received */
            polling_log_info("Client %s:%d sent FIN (graceful close)",
                            peer_ip, ntohs(client->peer_addr.sin6_port));
            break;
        }

        client->bytes_received += bytes_read;
        client->last_heartbeat = time(NULL);

        /* TODO: Parse WebSocket frame and handle based on type */
        /* This would call websocket_parse_frame() and message handlers */
    }

    /* Graceful disconnection */
    polling_log_info("Closing client %s:%d", peer_ip, ntohs(client->peer_addr.sin6_port));
    polling_client_disconnect(client);

    return NULL;
}

/**
 * polling_client_disconnect - Properly close client connection
 *
 * This triggers the TCP connection termination sequence:
 * 1. Send FIN (or wait for FIN from client)
 * 2. Enter FIN_WAIT_1 or CLOSE_WAIT
 * 3. Send final FIN-ACK
 * 4. Enter TIME_WAIT or CLOSED
 */
void polling_client_disconnect(client_conn_t* client) {
    if (!client || client->socket_fd < 0) return;

    char peer_ip[INET6_ADDRSTRLEN];
    inet_ntop(AF_INET6, &client->peer_addr.sin6_addr, peer_ip, sizeof(peer_ip));

    /* Log statistics */
    polling_log_info("Disconnecting client %s:%d - Sent: %lu bytes, Received: %lu bytes",
                     peer_ip, ntohs(client->peer_addr.sin6_port),
                     client->bytes_sent, client->bytes_received);

    /* Graceful shutdown: close both directions */
    if (shutdown(client->socket_fd, SHUT_RDWR) < 0) {
        if (errno != ENOTCONN) {
            polling_log_error("shutdown failed: %s", strerror(errno));
        }
    }

    close(client->socket_fd);
    client->socket_fd = -1;
    client->state = CLIENT_STATE_CLOSED;
    client->is_active = 0;

    /* Free allocated memory */
    if (client->session.voted_polls) {
        free(client->session.voted_polls);
        client->session.voted_polls = NULL;
    }

    polling_log_info("Client %s:%d fully closed", peer_ip, ntohs(client->peer_addr.sin6_port));
}

/**
 * polling_client_authenticate - Verify user credentials
 */
int polling_client_authenticate(client_conn_t* client, auth_request_t* auth_req) {
    /* TODO: Implement credential verification against password file/database */
    /* Should check for account lockout and failed attempt limits */
    return 0;
}

/**
 * polling_client_process_vote - Process and validate vote
 */
int polling_client_process_vote(client_conn_t* client, vote_request_t* vote_req) {
    /* TODO: Implement vote validation and database recording */
    return 0;
}

/* ============================================================================
 * MAIN SERVER ACCEPT LOOP
 * ============================================================================
 */

int polling_server_main_loop(polling_server_t* server) {
    struct sockaddr_in6 client_addr;
    socklen_t client_addr_len;
    int client_fd;
    client_conn_t* client_slot;
    int available_slot = -1;

    polling_log_info("Entering main accept loop");

    while (server->running && !g_shutdown) {
        client_addr_len = sizeof(client_addr);

        /* Accept new connection (blocks until SYN-ACK-ACK completed) */
        client_fd = accept(server->listen_socket, (struct sockaddr*)&client_addr,
                          &client_addr_len);

        if (client_fd < 0) {
            if (errno == EINTR) continue;
            polling_log_error("accept: %s", strerror(errno));
            continue;
        }

        char peer_ip[INET6_ADDRSTRLEN];
        inet_ntop(AF_INET6, &client_addr.sin6_addr, peer_ip, sizeof(peer_ip));
        polling_log_info("Accepted connection from %s:%d (fd=%d)",
                        peer_ip, ntohs(client_addr.sin6_port), client_fd);

        /* Configure accepted socket */
        if (polling_socket_set_keepalive(client_fd) < 0) goto reject;
        if (polling_socket_set_nodelay(client_fd) < 0) goto reject;
        if (polling_socket_set_buffer_sizes(client_fd) < 0) goto reject;

        /* Find available client slot */
        pthread_mutex_lock(&server->clients_lock);
        for (int i = 0; i < server->max_clients; i++) {
            if (!server->clients[i].is_active) {
                available_slot = i;
                break;
            }
        }
        pthread_mutex_unlock(&server->clients_lock);

        if (available_slot < 0) {
            polling_log_warning("No available client slots (max=%d)", server->max_clients);
            goto reject;
        }

        /* Initialize client structure */
        client_slot = &server->clients[available_slot];
        memset(client_slot, 0, sizeof(*client_slot));
        client_slot->socket_fd = client_fd;
        client_slot->is_active = 1;
        client_slot->peer_addr = client_addr;
        client_slot->state = CLIENT_STATE_CONNECTED;

        /* Create handler thread */
        if (pthread_create(&client_slot->handler_thread, NULL,
                          polling_client_handler, client_slot) < 0) {
            polling_log_error("pthread_create failed: %s", strerror(errno));
            client_slot->is_active = 0;
            goto reject;
        }

        continue;

reject:
        close(client_fd);
    }

    polling_log_info("Main loop exited");
    return 0;
}

/* ============================================================================
 * MAIN ENTRY POINT
 * ============================================================================
 */

int main(int argc, char* argv[]) {
    uint16_t port = 8443;  /* Default HTTPS WebSocket port */
    int max_clients = POLLING_MAX_CLIENTS;

    /* Parse command-line arguments */
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "-p") == 0 && i + 1 < argc) {
            port = atoi(argv[++i]);
        } else if (strcmp(argv[i], "-c") == 0 && i + 1 < argc) {
            max_clients = atoi(argv[++i]);
        }
    }

    /* Initialize syslog */
    polling_log_init("polling_server", LOG_LOCAL0);
    polling_log_info("Polling Server starting (version 1.0)");

    /* Register signal handlers */
    signal(SIGINT, polling_signal_handler);
    signal(SIGTERM, polling_signal_handler);
    signal(SIGPIPE, SIG_IGN);  /* Ignore broken pipe */

    /* Create server */
    g_server = polling_server_create(port, max_clients);
    if (!g_server) {
        fprintf(stderr, "Failed to create server\n");
        return EXIT_FAILURE;
    }

    /* Initialize database */
    if (polling_db_init(g_server) < 0) {
        polling_log_error("Database initialization failed");
        polling_server_destroy(g_server);
        return EXIT_FAILURE;
    }

    /* Start listening */
    if (polling_server_start(g_server) < 0) {
        polling_log_error("Failed to start server");
        polling_server_destroy(g_server);
        return EXIT_FAILURE;
    }

    /* Main accept loop */
    int ret = polling_server_main_loop(g_server);

    /* Cleanup */
    polling_server_destroy(g_server);
    polling_log_info("Polling Server shutdown complete");

    return ret == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
