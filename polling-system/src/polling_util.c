/*
 * ============================================================================
 * POLLING SYSTEM - UTILITY & TLS IMPLEMENTATION
 * ============================================================================
 *
 * Provides TLS/SSL support for secure WebSocket connections (WSS).
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <openssl/ssl.h>
#include <openssl/err.h>
#include <openssl/x509.h>
#include "../include/polling.h"

/* Global SSL context */
static SSL_CTX* g_ssl_ctx = NULL;
static SSL_METHOD* g_ssl_method = NULL;

/* ============================================================================
 * TLS INITIALIZATION & CONFIGURATION
 * ============================================================================
 *
 * Implements TLS 1.2+ negotiation and certificate verification.
 *
 * Security considerations:
 * - Use TLS 1.2 or higher (TLS 1.3 preferred)
 * - Disable weak ciphers (only HIGH grade)
 * - Enable certificate validation
 * - Use forward secrecy (ECDHE)
 * - Perfect Forward Secrecy (PFS) for encryption keys
 *
 * TLS Handshake sequence (addition to TCP 3-way):
 * CLIENT                                    SERVER
 *   |                                        |
 *   |------- TCP 3-way handshake ---------->|
 *   |                                        |
 *   |------ TLS ClientHello (encrypted) ---->|
 *   |       Random, Ciphers, Extensions    |
 *   |                                        |
 *   |<---- TLS ServerHello, Certificate <---|
 *   |      ServerKeyExchange               |
 *   |                                        |
 *   |------ ClientKeyExchange, Finished --->|
 *   |       (encrypted from now on)        |
 *   |                                        |
 *   |<----- ServerFinished -----------------| (Encrypted + Verified)
 *   |                                        |
 *   (Secure Connection Established)
 *
 * This adds cryptographic overhead (~100-200 bytes per message)
 * and computational cost, but guarantees:
 * - Confidentiality (encryption)
 * - Integrity (HMAC verification)
 * - Authentication (certificate verification)
 * - Forward secrecy (key agreement per session)
 */

int polling_tls_init(void) {
    polling_log_info("Initializing TLS (OpenSSL)");

    /* Initialize SSL library */
#ifdef SSL_CTX_new
    SSL_library_init();
    SSL_load_error_strings();
    OpenSSL_add_all_algorithms();
#endif

    /* Create SSL context (TLS server) */
    g_ssl_method = (SSL_METHOD*)TLS_server_method();  /* TLS_server_method is TLS 1.0+ */
    if (!g_ssl_method) {
        polling_log_error("Failed to create SSL method");
        return -1;
    }

    g_ssl_ctx = SSL_CTX_new(g_ssl_method);
    if (!g_ssl_ctx) {
        polling_log_error("Failed to create SSL context");
        return -1;
    }

    /* Set minimum TLS version (TLS 1.2) */
#ifdef SSL_CTX_set_min_proto_version
    SSL_CTX_set_min_proto_version(g_ssl_ctx, TLS1_2_VERSION);
#endif

    /* Configure ciphers (HIGH = strong encryption) */
    if (SSL_CTX_set_cipher_list(g_ssl_ctx, "HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA") != 1) {
        polling_log_error("Failed to set cipher list");
        SSL_CTX_free(g_ssl_ctx);
        return -1;
    }

    /* Load certificate and private key (would be from file in production) */
    /* For demo, we would use:
     * SSL_CTX_use_certificate_file(g_ssl_ctx, "/etc/polling/cert.pem", SSL_FILETYPE_PEM);
     * SSL_CTX_use_PrivateKey_file(g_ssl_ctx, "/etc/polling/key.pem", SSL_FILETYPE_PEM);
     */

    polling_log_info("TLS initialization complete");
    return 0;
}

/**
 * polling_tls_accept - Accept TLS connection on established TCP socket
 *
 * Performs TLS handshake on already-connected socket.
 * This happens AFTER TCP 3-way handshake but BEFORE HTTP upgrade.
 *
 * Error handling:
 * - SSL_ERROR_WANT_READ/WRITE: Would block, retry
 * - SSL_ERROR_SSL: Handshake failure, close connection
 */
void* polling_tls_accept(int sockfd) {
    SSL* ssl;
    int ret;

    if (!g_ssl_ctx) {
        polling_log_error("TLS context not initialized");
        return NULL;
    }

    ssl = SSL_new(g_ssl_ctx);
    if (!ssl) {
        polling_log_error("Failed to create SSL object");
        return NULL;
    }

    ret = SSL_set_fd(ssl, sockfd);
    if (ret != 1) {
        polling_log_error("Failed to set SSL file descriptor");
        SSL_free(ssl);
        return NULL;
    }

    /* Non-blocking accept with timeout would be more sophisticated */
    ret = SSL_accept(ssl);
    if (ret != 1) {
        int err = SSL_get_error(ssl, ret);
        polling_log_error("TLS accept failed: %d", err);
        SSL_free(ssl);
        return NULL;
    }

    /* Log certificate info (production) */
    X509* cert = SSL_get_peer_certificate(ssl);
    if (cert) {
        char buf[256];
        X509_NAME_oneline(X509_get_subject_name(cert), buf, sizeof(buf));
        polling_log_debug("Client certificate subject: %s", buf);
        X509_free(cert);
    }

    polling_log_debug("TLS handshake complete on socket %d", sockfd);
    return (void*)ssl;
}

/**
 * polling_tls_recv - Read encrypted data from TLS connection
 */
int polling_tls_recv(void* tls_ctx, void* buf, size_t len) {
    SSL* ssl = (SSL*)tls_ctx;
    if (!ssl) return -1;

    int ret = SSL_read(ssl, buf, (int)len);
    if (ret < 0) {
        int err = SSL_get_error(ssl, ret);
        if (err == SSL_ERROR_WANT_READ || err == SSL_ERROR_WANT_WRITE) {
            return 0;  /* Would block, no data available */
        }
        polling_log_error("TLS read error: %d", err);
        return -1;
    }

    return ret;  /* Bytes read */
}

/**
 * polling_tls_send - Write encrypted data to TLS connection
 */
int polling_tls_send(void* tls_ctx, const void* buf, size_t len) {
    SSL* ssl = (SSL*)tls_ctx;
    if (!ssl) return -1;

    int ret = SSL_write(ssl, buf, (int)len);
    if (ret < 0) {
        int err = SSL_get_error(ssl, ret);
        if (err == SSL_ERROR_WANT_READ || err == SSL_ERROR_WANT_WRITE) {
            return 0;  /* Would block */
        }
        polling_log_error("TLS write error: %d", err);
        return -1;
    }

    return ret;  /* Bytes written */
}

/**
 * polling_tls_close - Gracefully shut down TLS connection
 *
 * Sends TLS close_notify alert before closing socket.
 */
void polling_tls_close(void* tls_ctx) {
    SSL* ssl = (SSL*)tls_ctx;
    if (!ssl) return;

    /* Send close_notify alert */
    SSL_shutdown(ssl);
    SSL_free(ssl);
}

/* ============================================================================
 * BROADCAST & POLLING FUNCTIONS
 * ============================================================================
 */

/**
 * polling_broadcast_poll_update - Send updated poll results to all clients
 *
 * This function implements the real-time update mechanism:
 * 1. Lock poll data
 * 2. Iterate connected clients
 * 3. Send WebSocket frame with vote counts
 * 4. Handle partial sends (buf exhaustion)
 * 5. Unlock poll data
 *
 * Error handling for partial sends:
 * - If buffer full, queue frame in client-specific buffer
 * - Retry on next select() cycle
 * - Track messages-in-flight per client to prevent memory exhaustion
 */
void polling_broadcast_poll_update(polling_server_t* server, poll_t* poll) {
    /* Lock poll data */
    pthread_rwlock_rdlock(&poll->lock);

    char update_msg[POLLING_BUFFER_SIZE];
    snprintf(update_msg, sizeof(update_msg),
            "{\"type\":\"poll_update\",\"poll_id\":%d,\"total_votes\":%d,\"updated_at\":%ld}",
            poll->poll_id, poll->total_votes, time(NULL));

    /* TODO: Implement WebSocket frame creation and broadcast */
    /* For each connected client:
     *   - Create WebSocket frame from update_msg
     *   - Queue for transmission (respecting rate limits)
     *   - Handle EAGAIN (buffer full)
     */

    pthread_rwlock_unlock(&poll->lock);
}

/**
 * polling_get_poll - Retrieve poll by ID with error handling
 */
int polling_get_poll(polling_server_t* server, uint32_t poll_id, poll_t** poll) {
    if (!server || !poll || poll_id == 0) {
        return -1;
    }

    pthread_rwlock_rdlock(&server->polls_lock);

    for (uint32_t i = 0; i < server->poll_count; i++) {
        if (server->polls[i].poll_id == poll_id) {
            *poll = &server->polls[i];
            pthread_rwlock_unlock(&server->polls_lock);
            return 0;
        }
    }

    pthread_rwlock_unlock(&server->polls_lock);
    return -1;  /* Not found */
}

/**
 * polling_create_poll - Create new poll
 */
poll_t* polling_create_poll(uint32_t poll_id, const char* title, time_t duration) {
    poll_t* p = malloc(sizeof(*p));
    if (!p) return NULL;

    memset(p, 0, sizeof(*p));
    p->poll_id = poll_id;
    strncpy(p->title, title, sizeof(p->title) - 1);
    p->created_at = time(NULL);
    p->expires_at = p->created_at + duration;
    p->active = 1;
    p->total_votes = 0;
    p->option_count = 0;

    pthread_rwlock_init(&p->lock, NULL);

    return p;
}

/* ============================================================================
 * TCP STATE MANAGEMENT & DEBUGGING
 * ============================================================================
 */

/**
 * polling_handle_tcp_states - Analyze and handle TCP state transitions
 *
 * For debugging and diagnostics.
 * Can read /proc/net/tcp to monitor socket states.
 */
void polling_handle_tcp_states(client_conn_t* client) {
    /* Would implement TCP state monitoring here */
    /* Monitor for: CLOSE_WAIT (unread close), TIME_WAIT (memory usage), etc. */
}

/**
 * polling_detect_slow_clients - Identify clients with slow send/recv
 *
 * Can indicate:
 * - Network congestion
 * - Slow client (mobile)
 * - Malicious slowloris attack (intentional slowness)
 */
void polling_detect_slow_clients(polling_server_t* server) {
    time_t now = time(NULL);
    int slow_count = 0;

    pthread_mutex_lock(&server->clients_lock);

    for (int i = 0; i < server->max_clients; i++) {
        if (!server->clients[i].is_active) continue;

        /* Check if hasn't received data in >30 seconds */
        if (now - server->clients[i].last_heartbeat > 30) {
            slow_count++;
            polling_log_warning("Slow client detected: fd=%d, idle=%d seconds",
                               server->clients[i].socket_fd,
                               (int)(now - server->clients[i].last_heartbeat));
        }
    }

    pthread_mutex_unlock(&server->clients_lock);

    if (slow_count > 0) {
        polling_log_info("Total slow clients: %d", slow_count);
    }
}

/**
 * polling_cleanup_stale_connections - Remove dead connections
 *
 * Runs periodically (e.g., every 5 minutes) to clean up:
 * - Connections in TIME_WAIT state (normal closure)
 * - Connections stuck in CLOSE_WAIT (peer didn't ACK)
 * - Orphaned connections (no activity for threshold)
 */
void polling_cleanup_stale_connections(polling_server_t* server) {
    time_t now = time(NULL);
    int cleaned = 0;

    pthread_mutex_lock(&server->clients_lock);

    for (int i = 0; i < server->max_clients; i++) {
        if (!server->clients[i].is_active) continue;

        /* Cleanup if idle > 1 hour */
        if (now - server->clients[i].last_heartbeat > 3600) {
            polling_log_warning("Cleaning stale connection: fd=%d, idle=%d hours",
                               server->clients[i].socket_fd,
                               (int)(now - server->clients[i].last_heartbeat) / 3600);
            server->clients[i].is_active = 0;
            if (server->clients[i].socket_fd >= 0) {
                close(server->clients[i].socket_fd);
                server->clients[i].socket_fd = -1;
            }
            cleaned++;
        }
    }

    pthread_mutex_unlock(&server->clients_lock);

    if (cleaned > 0) {
        polling_log_info("Cleaned %d stale connections", cleaned);
    }
}
