/*
 * ============================================================================
 * POLLING SYSTEM - AUTHENTICATION & UTILITY FUNCTIONS
 * ============================================================================
 *
 * Implements:
 * - User authentication (credentials verification)
 * - Session token management
 * - Syslog integration for audit logging
 * - Flood detection
 * - Account lockout mechanism
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <syslog.h>
#include <openssl/rand.h>
#include <openssl/sha.h>
#include "../include/polling.h"

/* Syslog facility */
static int g_log_facility = LOG_LOCAL0;

/* ============================================================================
 * SYSLOG LOGGING FUNCTIONS
 * ============================================================================
 *
 * Integration with syslog(3) for centralized audit logging.
 * Critical for compliance, debugging, and forensic analysis.
 */

void polling_log_init(const char* ident, int facility) {
    g_log_facility = facility;
    openlog(ident, LOG_PID, facility);
}

void polling_log_info(const char* format, ...) {
    va_list args;
    va_start(args, format);
    vsyslog(LOG_INFO, format, args);
    fprintf(stdout, "[INFO] ");
    vfprintf(stdout, format, args);
    fprintf(stdout, "\n");
    va_end(args);
}

void polling_log_error(const char* format, ...) {
    va_list args;
    va_start(args, format);
    vsyslog(LOG_ERR, format, args);
    fprintf(stderr, "[ERROR] ");
    vfprintf(stderr, format, args);
    fprintf(stderr, "\n");
    va_end(args);
}

void polling_log_debug(const char* format, ...) {
    va_list args;
    va_start(args, format);
    vsyslog(LOG_DEBUG, format, args);
    fprintf(stdout, "[DEBUG] ");
    vfprintf(stdout, format, args);
    fprintf(stdout, "\n");
    va_end(args);
}

void polling_log_warning(const char* format, ...) {
    va_list args;
    va_start(args, format);
    vsyslog(LOG_WARNING, format, args);
    fprintf(stdout, "[WARN] ");
    vfprintf(stdout, format, args);
    fprintf(stdout, "\n");
    va_end(args);
}

/* ============================================================================
 * TOKEN GENERATION & VALIDATION
 * ============================================================================
 *
 * Implements secure session token generation using CSPRNG (cryptographically
 * secure pseudo-random number generator).
 *
 * Token format: 64-byte random hex string
 * Token lifetime: configurable (default 1 hour)
 *
 * In production:
 * - Use JWT with HMAC-SHA256 signature
 * - Include user_id, expiration, and permissions in token
 * - Implement token revocation list
 * - Rotate keys periodically
 */

char* polling_auth_generate_token(uint32_t user_id) {
    static char token_buffer[POLLING_SESSION_TOKEN_LEN];
    unsigned char random_bytes[32];
    char hex_buffer[65];

    /* Generate 32 random bytes */
    if (RAND_bytes(random_bytes, sizeof(random_bytes)) != 1) {
        polling_log_error("Failed to generate random bytes for token");
        return NULL;
    }

    /* Convert to hex string */
    for (int i = 0; i < 32; i++) {
        snprintf(&hex_buffer[i*2], 3, "%02x", random_bytes[i]);
    }
    hex_buffer[64] = '\0';

    /* In production, would format as JWT with user_id and expiration */
    snprintf(token_buffer, sizeof(token_buffer), "%d:%s", user_id, hex_buffer);

    polling_log_debug("Generated session token for user_id=%d", user_id);
    return token_buffer;
}

int polling_auth_validate_token(const char* token) {
    /* In production, would:
     * 1. Parse JWT
     * 2. Verify HMAC signature
     * 3. Check expiration time
     * 4. Check against revocation list
     */

    if (!token || strlen(token) < 10) {
        return 0;  /* Invalid */
    }

    char* colon = strchr(token, ':');
    if (!colon) {
        return 0;  /* Invalid format */
    }

    /* Validate format: user_id:hex_string */
    uint32_t user_id = atoi(token);
    if (user_id == 0) {
        return 0;  /* Invalid user_id */
    }

    return 1;  /* Valid */
}

/* ============================================================================
 * CREDENTIAL VERIFICATION
 * ============================================================================
 *
 * In production, credentials should be:
 * 1. Stored with password hash (bcrypt, scrypt, or argon2)
 * 2. Salted with random value
 * 3. Hashed with slow algorithm (adaptive cost factor)
 * 4. Time-constant comparison to prevent timing attacks
 *
 * This example uses plaintext for demonstration (INSECURE).
 */

static const char* DEMO_USERS[] = {
    "alice:password123",
    "bob:securepass456",
    "charlie:voting789",
    NULL
};

int polling_auth_verify_credentials(const char* username, const char* password) {
    for (int i = 0; DEMO_USERS[i]; i++) {
        const char* user_pass = DEMO_USERS[i];
        const char* colon = strchr(user_pass, ':');
        if (!colon) continue;

        int username_len = colon - user_pass;
        if (strncmp(username, user_pass, username_len) == 0 &&
            username[username_len] == '\0' &&
            strcmp(password, colon + 1) == 0) {
            polling_log_info("User '%s' authenticated successfully", username);
            return 1;  /* Match */
        }
    }

    polling_log_warning("Authentication failed for user '%s'", username);
    return 0;  /* No match */
}

uint32_t polling_auth_get_user_id(const char* username) {
    /* Simple hash for demo purposes */
    uint32_t hash = 0;
    for (const char* p = username; *p; p++) {
        hash = hash * 31 + *p;
    }
    return hash % 10000;  /* Constrain to demo range */
}

/* ============================================================================
 * FLOOD DETECTION & RATE LIMITING
 * ============================================================================
 *
 * Implements basic rate limiting to prevent voting floods.
 * In production:
 * - Use sliding window algorithm
 * - Implement per-user, per-IP, and global limits
 * - Integrate with GeoIP for geographic anomaly detection
 * - Log to separate audit file for analysis
 */

int polling_auth_check_flood(client_conn_t* client) {
    time_t now = time(NULL);
    time_t time_window = 60;  /* 60 second window */

    if (client->session.last_activity == 0) {
        client->session.last_activity = now;
        client->session.votes_cast = 0;
        return 0;  /* First activity */
    }

    /* Reset window if expired */
    if (now - client->session.last_activity > time_window) {
        client->session.last_activity = now;
        client->session.votes_cast = 0;
        return 0;
    }

    /* Check vote rate */
    if (client->session.votes_cast > 10) {  /* Max 10 votes per minute */
        polling_log_warning("Vote flood detected: user=%s, votes_in_window=%d",
                           client->session.username, client->session.votes_cast);
        return 1;  /* Flood */
    }

    return 0;  /* OK */
}

/* ============================================================================
 * ACCOUNT LOCKOUT MECHANISM
 * ============================================================================
 *
 * Prevents brute-force attacks by temporarily locking accounts after
 * multiple failed login attempts.
 */

int polling_auth_check_lockout(client_conn_t* client, const char* username) {
    time_t now = time(NULL);

    /* Check if still locked */
    if (client->session.lockout_until > now) {
        uint32_t remaining = client->session.lockout_until - now;
        polling_log_warning("Account locked for user '%s': %d seconds remaining",
                           username, remaining);
        return 1;  /* Still locked */
    }

    /* Reset lock if expired */
    if (client->session.lockout_until > 0) {
        client->session.failed_login_attempts = 0;
        client->session.lockout_until = 0;
    }

    return 0;  /* Not locked */
}

void polling_auth_record_failed_login(client_conn_t* client, const char* username) {
    client->session.failed_login_attempts++;
    polling_log_warning("Login failed for '%s': attempt %d",
                       username, client->session.failed_login_attempts);

    if (client->session.failed_login_attempts >= MAX_FAILED_LOGIN_ATTEMPTS) {
        client->session.lockout_until = time(NULL) + LOCKOUT_DURATION;
        polling_log_warning("Account '%s' locked for %d seconds",
                           username, LOCKOUT_DURATION);
    }
}

void polling_auth_record_successful_login(client_conn_t* client) {
    client->session.failed_login_attempts = 0;
    client->session.lockout_until = 0;
    client->session.last_activity = time(NULL);
    client->session.authenticated = 1;
    polling_log_info("User '%s' (ID=%d) authenticated, session started",
                    client->session.username, client->session.user_id);
}

/* ============================================================================
 * MEMORY UTILITIES
 * ============================================================================
 */

void polling_secure_memzero(void* ptr, size_t len) {
    /* Securely clear sensitive memory to prevent leaks */
    volatile unsigned char* p = (volatile unsigned char*)ptr;
    while (len--) *p++ = 0;
}
