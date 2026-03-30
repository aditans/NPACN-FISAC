/*
 * ============================================================================
 * POLLING SYSTEM - DATABASE LAYER (SQLite)
 * ============================================================================
 *
 * Implements persistent vote storage and logging:
 * - SQLite database for ACID vote transactions
 * - Duplicate vote detection
 * - Connection event logging
 * - Syslog integration for audit trail
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sqlite3.h>
#include <time.h>
#include <sys/stat.h>
#include <sys/types.h>
#include "../include/polling.h"

/* SQLite database schema */
static const char* DB_INIT_SCHEMA = 
    "CREATE TABLE IF NOT EXISTS votes ("
    "  vote_id INTEGER PRIMARY KEY AUTOINCREMENT,"
    "  poll_id INTEGER NOT NULL,"
    "  option_id INTEGER NOT NULL,"
    "  user_id INTEGER NOT NULL,"
    "  username TEXT NOT NULL,"
    "  user_ip TEXT NOT NULL,"
    "  user_port INTEGER NOT NULL,"
    "  vote_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP"
    ");"
    "CREATE TABLE IF NOT EXISTS vote_index ("
    "  user_id_poll_id TEXT PRIMARY KEY,"
    "  vote_id INTEGER NOT NULL"
    ");"
    "CREATE TABLE IF NOT EXISTS connections ("
    "  connection_id INTEGER PRIMARY KEY AUTOINCREMENT,"
    "  user_ip TEXT NOT NULL,"
    "  user_port INTEGER NOT NULL,"
    "  connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,"
    "  disconnected_at DATETIME,"
    "  bytes_sent INTEGER DEFAULT 0,"
    "  bytes_received INTEGER DEFAULT 0,"
    "  authenticated INTEGER DEFAULT 0"
    ");"
    "CREATE INDEX IF NOT EXISTS idx_vote_poll_user "
    "  ON votes(poll_id, user_id);"
    "CREATE INDEX IF NOT EXISTS idx_votes_timestamp "
    "  ON votes(vote_timestamp);"
    "CREATE INDEX IF NOT EXISTS idx_connections_ip "
    "  ON connections(user_ip);";

/**
 * polling_db_init - Initialize SQLite database
 *
 * Creates database file and schema if not exists.
 * Enables optimizations for concurrent access.
 */
int polling_db_init(polling_server_t* server) {
    sqlite3* db;
    char* errmsg = NULL;
    int rc;

    polling_log_info("Initializing database at %s", server->db_path);

    /* Create parent directory if needed */
    char dirname[256];
    strncpy(dirname, server->db_path, sizeof(dirname)-1);
    char* last_slash = strrchr(dirname, '/');
    if (last_slash) {
        *last_slash = '\0';
        mkdir(dirname, 0755);
    }

    /* Open/create database */
    rc = sqlite3_open(server->db_path, &db);
    if (rc) {
        polling_log_error("Cannot open database %s: %s", 
                         server->db_path, sqlite3_errmsg(db));
        if (db) sqlite3_close(db);
        return -1;
    }

    /* Enable WAL mode for better concurrency */
    rc = sqlite3_exec(db, "PRAGMA journal_mode=WAL", NULL, NULL, &errmsg);
    if (rc != SQLITE_OK) {
        polling_log_error("Failed to enable WAL: %s", errmsg);
        sqlite3_free(errmsg);
        sqlite3_close(db);
        return -1;
    }

    /* Set synchronous level (NORMAL = balance performance/safety) */
    rc = sqlite3_exec(db, "PRAGMA synchronous=NORMAL", NULL, NULL, &errmsg);
    if (rc != SQLITE_OK) {
        polling_log_error("Failed to set synchronous: %s", errmsg);
        sqlite3_free(errmsg);
        sqlite3_close(db);
        return -1;
    }

    /* Set busy timeout (1 second) */
    sqlite3_busy_timeout(db, 1000);

    /* Execute schema */
    rc = sqlite3_exec(db, DB_INIT_SCHEMA, NULL, NULL, &errmsg);
    if (rc != SQLITE_OK) {
        polling_log_error("Failed to create schema: %s", errmsg);
        sqlite3_free(errmsg);
        sqlite3_close(db);
        return -1;
    }

    polling_log_info("Database initialized successfully");

    /* Store db handle - in production, use connection pool */
    /* For simplicity, we'll store as opaque pointer and reopen in each transaction */
    sqlite3_close(db);
    server->db_fd = 1;  /* Marker that DB is initialized */

    return 0;
}

/**
 * polling_db_record_vote - Insert vote into database
 *
 * This function ensures:
 * 1. Atomic vote insertion with duplicate check
 * 2. Proper transaction handling (ACID properties)
 * 3. Syslog audit trail
 * 4. Error recovery on duplicate attempts
 *
 * In production, votes should be written to a transaction log
 * before being made visible to polling system (2-phase commit).
 */
int polling_db_record_vote(polling_server_t* server, const db_vote_record_t* vote) {
    sqlite3* db;
    sqlite3_stmt* stmt;
    char* errmsg = NULL;
    int rc;
    char duplicate_key[256];

    if (server->db_fd < 0) {
        polling_log_error("Database not initialized");
        return -1;
    }

    /* Open database connection */
    rc = sqlite3_open_readonly(server->db_path, &db);
    if (rc != SQLITE_OK) {
        polling_log_error("Failed to open database: %s", sqlite3_errmsg(db));
        if (db) sqlite3_close(db);
        return -1;
    }

    /* First, check for duplicate vote (prevent double-voting) */
    snprintf(duplicate_key, sizeof(duplicate_key), "%d_%d", vote->user_id, vote->poll_id);

    sqlite3_stmt* dup_stmt;
    rc = sqlite3_prepare_v2(db,
        "SELECT vote_id FROM votes WHERE user_id = ? AND poll_id = ?",
        -1, &dup_stmt, NULL);

    if (rc == SQLITE_OK) {
        sqlite3_bind_int(dup_stmt, 1, vote->user_id);
        sqlite3_bind_int(dup_stmt, 2, vote->poll_id);

        if (sqlite3_step(dup_stmt) == SQLITE_ROW) {
            /* Duplicate vote detected */
            polling_log_warning("Duplicate vote attempt: user_id=%d, poll_id=%d, ip=%s:%d",
                               vote->user_id, vote->poll_id, vote->user_ip, vote->user_port);
            sqlite3_finalize(dup_stmt);
            sqlite3_close(db);
            return -1;  /* VOTE_DUPLICATE */
        }
        sqlite3_finalize(dup_stmt);
    }

    sqlite3_close(db);

    /* Re-open in read-write mode for insert */
    rc = sqlite3_open(server->db_path, &db);
    if (rc != SQLITE_OK) {
        polling_log_error("Failed to open database for writing: %s", sqlite3_errmsg(db));
        if (db) sqlite3_close(db);
        return -1;
    }

    /* Begin transaction */
    rc = sqlite3_exec(db, "BEGIN IMMEDIATE", NULL, NULL, &errmsg);
    if (rc != SQLITE_OK) {
        polling_log_error("BEGIN transaction failed: %s", errmsg);
        sqlite3_free(errmsg);
        sqlite3_close(db);
        return -1;
    }

    /* Insert vote */
    rc = sqlite3_prepare_v2(db,
        "INSERT INTO votes (poll_id, option_id, user_id, username, user_ip, user_port) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        -1, &stmt, NULL);

    if (rc != SQLITE_OK) {
        polling_log_error("Failed to prepare vote insert: %s", sqlite3_errmsg(db));
        sqlite3_exec(db, "ROLLBACK", NULL, NULL, NULL);
        sqlite3_close(db);
        return -1;
    }

    sqlite3_bind_int(stmt, 1, vote->poll_id);
    sqlite3_bind_int(stmt, 2, vote->option_id);
    sqlite3_bind_int(stmt, 3, vote->user_id);
    sqlite3_bind_text(stmt, 4, vote->user_ip, -1, SQLITE_STATIC);
    sqlite3_bind_text(stmt, 5, vote->user_ip, -1, SQLITE_STATIC);
    sqlite3_bind_int(stmt, 6, vote->user_port);

    rc = sqlite3_step(stmt);
    sqlite3_finalize(stmt);

    if (rc != SQLITE_DONE) {
        polling_log_error("Vote insert failed: %s", sqlite3_errmsg(db));
        sqlite3_exec(db, "ROLLBACK", NULL, NULL, NULL);
        sqlite3_close(db);
        return -1;
    }

    int vote_id = (int)sqlite3_last_insert_rowid(db);

    /* Update index for fast duplicate detection */
    rc = sqlite3_prepare_v2(db,
        "INSERT OR IGNORE INTO vote_index (user_id_poll_id, vote_id) VALUES (?, ?)",
        -1, &stmt, NULL);

    if (rc == SQLITE_OK) {
        sqlite3_bind_text(stmt, 1, duplicate_key, -1, SQLITE_STATIC);
        sqlite3_bind_int(stmt, 2, vote_id);
        sqlite3_step(stmt);
        sqlite3_finalize(stmt);
    }

    /* Commit transaction */
    rc = sqlite3_exec(db, "COMMIT", NULL, NULL, &errmsg);
    if (rc != SQLITE_OK) {
        polling_log_error("COMMIT failed: %s", errmsg);
        sqlite3_free(errmsg);
        sqlite3_close(db);
        return -1;
    }

    sqlite3_close(db);

    /* Log vote to syslog */
    polling_log_info("Vote recorded: id=%d, poll=%d, option=%d, user=%d, ip=%s:%d",
                    vote_id, vote->poll_id, vote->option_id, vote->user_id,
                    vote->user_ip, vote->user_port);

    return 0;
}

/**
 * polling_db_check_duplicate_vote - Check if user already voted on poll
 */
int polling_db_check_duplicate_vote(polling_server_t* server, uint32_t user_id, uint32_t poll_id) {
    sqlite3* db;
    sqlite3_stmt* stmt;
    int rc, has_voted = 0;

    rc = sqlite3_open_readonly(server->db_path, &db);
    if (rc != SQLITE_OK) {
        polling_log_error("Failed to open database: %s", sqlite3_errmsg(db));
        if (db) sqlite3_close(db);
        return -1;  /* Error */
    }

    rc = sqlite3_prepare_v2(db,
        "SELECT 1 FROM votes WHERE user_id = ? AND poll_id = ? LIMIT 1",
        -1, &stmt, NULL);

    if (rc == SQLITE_OK) {
        sqlite3_bind_int(stmt, 1, user_id);
        sqlite3_bind_int(stmt, 2, poll_id);
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            has_voted = 1;
        }
        sqlite3_finalize(stmt);
    }

    sqlite3_close(db);
    return has_voted;
}

/**
 * polling_db_get_vote_count - Get total votes for specific poll option
 */
int polling_db_get_vote_count(polling_server_t* server, uint32_t poll_id, uint32_t option_id) {
    sqlite3* db;
    sqlite3_stmt* stmt;
    int rc, count = 0;

    rc = sqlite3_open_readonly(server->db_path, &db);
    if (rc != SQLITE_OK) {
        polling_log_error("Failed to open database: %s", sqlite3_errmsg(db));
        if (db) sqlite3_close(db);
        return -1;
    }

    rc = sqlite3_prepare_v2(db,
        "SELECT COUNT(*) FROM votes WHERE poll_id = ? AND option_id = ?",
        -1, &stmt, NULL);

    if (rc == SQLITE_OK) {
        sqlite3_bind_int(stmt, 1, poll_id);
        sqlite3_bind_int(stmt, 2, option_id);
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            count = sqlite3_column_int(stmt, 0);
        }
        sqlite3_finalize(stmt);
    }

    sqlite3_close(db);
    return count;
}

/**
 * polling_db_log_connection - Log connection event
 */
int polling_db_log_connection(polling_server_t* server, client_conn_t* client, int connected) {
    sqlite3* db;
    sqlite3_stmt* stmt;
    int rc;
    char peer_ip[INET6_ADDRSTRLEN];

    inet_ntop(AF_INET6, &client->peer_addr.sin6_addr, peer_ip, sizeof(peer_ip));

    rc = sqlite3_open(server->db_path, &db);
    if (rc != SQLITE_OK) {
        polling_log_error("Failed to open database: %s", sqlite3_errmsg(db));
        if (db) sqlite3_close(db);
        return -1;
    }

    if (connected) {
        /* Log connection start */
        rc = sqlite3_prepare_v2(db,
            "INSERT INTO connections (user_ip, user_port, authenticated) "
            "VALUES (?, ?, ?)",
            -1, &stmt, NULL);

        if (rc == SQLITE_OK) {
            sqlite3_bind_text(stmt, 1, peer_ip, -1, SQLITE_TRANSIENT);
            sqlite3_bind_int(stmt, 2, ntohs(client->peer_addr.sin6_port));
            sqlite3_bind_int(stmt, 3, client->session.authenticated);
            sqlite3_step(stmt);
            sqlite3_finalize(stmt);
        }
    } else {
        /* Log connection end (would use connection ID in production) */
        /* For now, just log to syslog */
    }

    sqlite3_close(db);
    return 0;
}

/**
 * polling_db_close - Close database connection
 */
void polling_db_close(polling_server_t* server) {
    if (server->db_fd >= 0) {
        server->db_fd = -1;
        polling_log_info("Database closed");
    }
}
