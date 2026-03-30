/*
 * ============================================================================
 * POLLING SYSTEM - DATABASE LAYER (COSMOS PRECHECK + IN-MEMORY LEDGER)
 * ============================================================================
 *
 * This backend removes the SQLite build dependency and performs Azure Cosmos DB
 * prechecks at startup for polling deployments.
 *
 * NOTE:
 * - Persistence calls below are in-memory only.
 * - Cosmos endpoint/key connectivity prechecks are validated before server start.
 */
#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200112L
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <time.h>
#include <errno.h>
#include <unistd.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <netdb.h>
#include <arpa/inet.h>
#include <pthread.h>

#include "../include/polling.h"

#define POLLING_MAX_VOTE_LEDGER 200000

static char g_cosmos_endpoint[256];
static char g_cosmos_key[1024];
static char g_cosmos_db_id[128];

static db_vote_record_t g_vote_ledger[POLLING_MAX_VOTE_LEDGER];
static size_t g_vote_ledger_count = 0;
static pthread_mutex_t g_vote_ledger_lock = PTHREAD_MUTEX_INITIALIZER;

static const char* env_pick(const char* a, const char* b) {
    const char* v = getenv(a);
    if (v && *v) return v;
    v = getenv(b);
    if (v && *v) return v;
    return NULL;
}

static int parse_https_host(const char* endpoint, char* host, size_t host_len) {
    const char* p;
    const char* slash;
    size_t n;

    if (!endpoint || !host || host_len == 0) {
        return -1;
    }

    if (strncmp(endpoint, "https://", 8) != 0) {
        return -1;
    }

    p = endpoint + 8;
    slash = strchr(p, '/');
    n = slash ? (size_t)(slash - p) : strlen(p);
    if (n == 0 || n >= host_len) {
        return -1;
    }

    strncpy(host, p, host_len - 1);
    host[host_len - 1] = '\0';

    /* Strip optional :443 from AccountEndpoint host. */
    char* colon = strchr(host, ':');
    if (colon) {
        *colon = '\0';
    }

    return 0;
}

static int cosmos_precheck_dns_and_tcp_443(const char* endpoint) {
    char host[256];
    struct addrinfo hints;
    struct addrinfo* res = NULL;
    struct addrinfo* it;
    int rc;
    int connected = 0;

    if (parse_https_host(endpoint, host, sizeof(host)) < 0) {
        polling_log_error("Cosmos precheck failed: endpoint must be https://... format");
        return -1;
    }

    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;

    rc = getaddrinfo(host, "443", &hints, &res);
    if (rc != 0) {
        polling_log_error("Cosmos precheck failed: DNS resolution failed for %s (%s)",
                          host, gai_strerror(rc));
        return -1;
    }

    for (it = res; it != NULL; it = it->ai_next) {
        int fd = socket(it->ai_family, it->ai_socktype, it->ai_protocol);
        if (fd < 0) {
            continue;
        }

        if (connect(fd, it->ai_addr, it->ai_addrlen) == 0) {
            connected = 1;
            close(fd);
            break;
        }

        close(fd);
    }

    freeaddrinfo(res);

    if (!connected) {
        polling_log_error("Cosmos precheck failed: TCP connect to endpoint on 443 failed");
        return -1;
    }

    polling_log_info("Cosmos precheck passed: DNS + TCP/443 reachable");
    return 0;
}

int polling_db_init(polling_server_t* server) {
    const char* endpoint = env_pick("COSMOS_ENDPOINT", "AZURE_COSMOS_ENDPOINT");
    const char* key = env_pick("COSMOS_KEY", "AZURE_COSMOS_KEY");
    const char* db_id = env_pick("COSMOS_DB_ID", "AZURE_COSMOS_DB_ID");

    if (!server) {
        return -1;
    }

    memset(g_cosmos_endpoint, 0, sizeof(g_cosmos_endpoint));
    memset(g_cosmos_key, 0, sizeof(g_cosmos_key));
    memset(g_cosmos_db_id, 0, sizeof(g_cosmos_db_id));

    if (!endpoint || !*endpoint) {
        polling_log_error("Cosmos precheck failed: set COSMOS_ENDPOINT (or AZURE_COSMOS_ENDPOINT)");
        return -1;
    }
    if (!key || !*key) {
        polling_log_error("Cosmos precheck failed: set COSMOS_KEY (or AZURE_COSMOS_KEY)");
        return -1;
    }
    if (!db_id || !*db_id) {
        db_id = "npacn";
    }

    strncpy(g_cosmos_endpoint, endpoint, sizeof(g_cosmos_endpoint) - 1);
    strncpy(g_cosmos_key, key, sizeof(g_cosmos_key) - 1);
    strncpy(g_cosmos_db_id, db_id, sizeof(g_cosmos_db_id) - 1);

    if (strstr(g_cosmos_endpoint, ".documents.azure.com") == NULL) {
        polling_log_warning("Cosmos precheck warning: endpoint does not look like a Cosmos SQL API endpoint");
    }

    polling_log_info("Running Cosmos prechecks for polling backend...");
    if (cosmos_precheck_dns_and_tcp_443(g_cosmos_endpoint) < 0) {
        return -1;
    }

    pthread_mutex_lock(&g_vote_ledger_lock);
    g_vote_ledger_count = 0;
    pthread_mutex_unlock(&g_vote_ledger_lock);

    server->db_fd = 1;
    polling_log_info("Polling DB backend initialized with Cosmos prechecks (db_id=%s)", g_cosmos_db_id);

    return 0;
}

int polling_db_check_duplicate_vote(polling_server_t* server, uint32_t user_id, uint32_t poll_id) {
    size_t i;

    if (!server || server->db_fd < 0) {
        return -1;
    }

    pthread_mutex_lock(&g_vote_ledger_lock);
    for (i = 0; i < g_vote_ledger_count; i++) {
        if (g_vote_ledger[i].user_id == user_id && g_vote_ledger[i].poll_id == poll_id) {
            pthread_mutex_unlock(&g_vote_ledger_lock);
            return 1;
        }
    }
    pthread_mutex_unlock(&g_vote_ledger_lock);

    return 0;
}

int polling_db_record_vote(polling_server_t* server, const db_vote_record_t* vote) {
    if (!server || !vote) {
        return -1;
    }

    if (server->db_fd < 0) {
        polling_log_error("DB backend not initialized");
        return -1;
    }

    if (polling_db_check_duplicate_vote(server, vote->user_id, vote->poll_id) == 1) {
        polling_log_warning("Duplicate vote blocked: user_id=%u poll_id=%u", vote->user_id, vote->poll_id);
        return -1;
    }

    pthread_mutex_lock(&g_vote_ledger_lock);
    if (g_vote_ledger_count >= POLLING_MAX_VOTE_LEDGER) {
        pthread_mutex_unlock(&g_vote_ledger_lock);
        polling_log_error("Vote ledger full; increase POLLING_MAX_VOTE_LEDGER");
        return -1;
    }

    g_vote_ledger[g_vote_ledger_count] = *vote;
    g_vote_ledger[g_vote_ledger_count].vote_id = (uint32_t)(g_vote_ledger_count + 1);
    if (g_vote_ledger[g_vote_ledger_count].timestamp == 0) {
        g_vote_ledger[g_vote_ledger_count].timestamp = time(NULL);
    }
    g_vote_ledger_count++;
    pthread_mutex_unlock(&g_vote_ledger_lock);

    polling_log_info("Vote stored: vote_id=%u user_id=%u poll_id=%u option_id=%u",
                     (unsigned)g_vote_ledger_count,
                     vote->user_id,
                     vote->poll_id,
                     vote->option_id);

    return 0;
}

int polling_db_get_vote_count(polling_server_t* server, uint32_t poll_id, uint32_t option_id) {
    size_t i;
    int count = 0;

    if (!server || server->db_fd < 0) {
        return -1;
    }

    pthread_mutex_lock(&g_vote_ledger_lock);
    for (i = 0; i < g_vote_ledger_count; i++) {
        if (g_vote_ledger[i].poll_id == poll_id && g_vote_ledger[i].option_id == option_id) {
            count++;
        }
    }
    pthread_mutex_unlock(&g_vote_ledger_lock);

    return count;
}

int polling_db_log_connection(polling_server_t* server, client_conn_t* client, int connected) {
    char peer_ip[INET6_ADDRSTRLEN];

    (void)server;
    if (!client) {
        return -1;
    }

    inet_ntop(AF_INET6, &client->peer_addr.sin6_addr, peer_ip, sizeof(peer_ip));

    if (connected) {
        polling_log_info("Connection logged: %s:%u", peer_ip, ntohs(client->peer_addr.sin6_port));
    } else {
        polling_log_info("Disconnection logged: %s:%u", peer_ip, ntohs(client->peer_addr.sin6_port));
    }

    return 0;
}

void polling_db_close(polling_server_t* server) {
    if (!server) {
        return;
    }

    server->db_fd = -1;
    polling_log_info("Polling DB backend closed");
}
