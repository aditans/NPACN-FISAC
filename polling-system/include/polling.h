#ifndef __POLLING_H__
#define __POLLING_H__

#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200112L
#endif

#include <stdint.h>
#include <time.h>
#include <stddef.h>
#include <sys/types.h>
#include <sys/time.h>
#include <pthread.h>
#include <netinet/in.h>
#include <arpa/inet.h>

/* ============================================================================
 * POLLING SYSTEM - CORE DEFINITIONS
 * ============================================================================
 */

#define POLLING_MAX_CLIENTS        1024
#define POLLING_MAX_POLL_OPTIONS   10
#define POLLING_MAX_POLLS           100
#define POLLING_BUFFER_SIZE         4096
#define POLLING_USERNAME_LEN        64
#define POLLING_PASSWORD_LEN        128
#define POLLING_POLL_TITLE_LEN      256
#define POLLING_OPTION_LEN          128
#define POLLING_SESSION_TOKEN_LEN   64

/* TCP Socket Options Configuration */
#define POLLING_SO_REUSEADDR        1    /* Allow immediate port reuse */
#define POLLING_SO_KEEPALIVE        1    /* Enable TCP keepalive */
#define POLLING_TCP_NODELAY         1    /* Disable Nagle's algorithm for low latency */
#define POLLING_SO_RCVBUF_SIZE      65536 /* 64 KB receive buffer */
#define POLLING_SO_SNDBUF_SIZE      65536 /* 64 KB send buffer */
#define POLLING_KEEPALIVE_IDLE      60    /* 60 seconds before first keepalive probe */
#define POLLING_KEEPALIVE_INTERVAL  10    /* 10 seconds between probes */
#define POLLING_KEEPALIVE_COUNT     5     /* 5 failed probes before timeout */

/* WebSocket Protocol Constants */
#define WEBSOCKET_MAGIC_STRING      "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
#define WEBSOCKET_HANDSHAKE_TIMEOUT 5    /* seconds */
#define WEBSOCKET_PING_INTERVAL     30   /* seconds */
#define MAX_FRAME_PAYLOAD_SIZE      (1024 * 64)

/* Authentication & Security */
#define AUTH_TOKEN_EXPIRY           3600  /* 1 hour */
#define MAX_FAILED_LOGIN_ATTEMPTS   5
#define LOCKOUT_DURATION            300   /* 5 minutes */
#define TLS_PROTOCOL_VERSION        12    /* TLS 1.2 */

/* Message Types */
typedef enum {
    MSG_TYPE_AUTH_REQUEST,      /* Client authentication */
    MSG_TYPE_AUTH_RESPONSE,     /* Server authentication result */
    MSG_TYPE_VOTE,              /* Client casting a vote */
    MSG_TYPE_VOTE_RESPONSE,     /* Server vote confirmation */
    MSG_TYPE_POLL_UPDATE,       /* Real-time poll result broadcast */
    MSG_TYPE_POLL_LIST,         /* List of available polls */
    MSG_TYPE_HEARTBEAT,         /* Keep-alive ping */
    MSG_TYPE_ERROR,             /* Error message */
    MSG_TYPE_DISCONNECT         /* Graceful disconnect */
} polling_msg_type_t;

/* Vote Status Codes */
typedef enum {
    VOTE_OK = 0,
    VOTE_DUPLICATE,
    VOTE_INVALID_POLL,
    VOTE_INVALID_OPTION,
    VOTE_UNAUTHORIZED,
    VOTE_POLL_CLOSED,
    VOTE_FLOOD_DETECTED,
    VOTE_DB_ERROR
} vote_status_t;

/* Client State */
typedef enum {
    CLIENT_STATE_CONNECTED,
    CLIENT_STATE_AUTHENTICATING,
    CLIENT_STATE_AUTHENTICATED,
    CLIENT_STATE_VOTING,
    CLIENT_STATE_DISCONNECTING,
    CLIENT_STATE_CLOSED
} client_state_t;

/* Database Vote Record */
typedef struct {
    uint32_t vote_id;
    uint32_t poll_id;
    uint32_t option_id;
    uint32_t user_id;
    time_t timestamp;
    char user_ip[INET6_ADDRSTRLEN];
    uint16_t user_port;
} db_vote_record_t;

/* In-Memory Vote Count */
typedef struct {
    uint32_t option_id;
    uint32_t vote_count;
    char option_text[POLLING_OPTION_LEN];
} poll_option_t;

/* Poll Definition */
typedef struct {
    uint32_t poll_id;
    char title[POLLING_POLL_TITLE_LEN];
    time_t created_at;
    time_t expires_at;
    int active;
    uint32_t total_votes;
    poll_option_t options[POLLING_MAX_POLL_OPTIONS];
    uint32_t option_count;
    pthread_mutex_t lock;
} poll_t;

/* User Session */
typedef struct {
    uint32_t user_id;
    char username[POLLING_USERNAME_LEN];
    char session_token[POLLING_SESSION_TOKEN_LEN];
    time_t token_issued_at;
    time_t last_activity;
    int authenticated;
    uint32_t failed_login_attempts;
    time_t lockout_until;
    uint32_t votes_cast;
    uint32_t* voted_polls;  /* Array of poll IDs user voted on */
    size_t voted_polls_count;
} user_session_t;

/* Client Connection */
typedef struct {
    int socket_fd;
    client_state_t state;
    user_session_t session;
    char recv_buffer[POLLING_BUFFER_SIZE];
    size_t recv_len;
    time_t last_heartbeat;
    int websocket_upgraded;
    int tls_enabled;
    void* tls_context;
    pthread_t handler_thread;
    struct sockaddr_in6 peer_addr;
    time_t connected_at;
    uint64_t bytes_received;
    uint64_t bytes_sent;
    int is_active;
} client_conn_t;

/* Server Global State */
typedef struct {
    int listen_socket;
    uint16_t port;
    int running;
    int max_clients;
    client_conn_t* clients;
    pthread_mutex_t clients_lock;
    poll_t* polls;
    uint32_t poll_count;
    pthread_mutex_t polls_lock;
    int db_fd;  /* SQLite database file descriptor */
    char db_path[256];
    int log_facility;  /* Syslog facility */
} polling_server_t;

/* TCP Three-Way Handshake States */
typedef enum {
    TCP_STATE_LISTEN,
    TCP_STATE_SYN_SENT,
    TCP_STATE_SYN_RCVD,
    TCP_STATE_ESTABLISHED,
    TCP_STATE_FIN_WAIT_1,
    TCP_STATE_FIN_WAIT_2,
    TCP_STATE_CLOSE_WAIT,
    TCP_STATE_CLOSING,
    TCP_STATE_TIME_WAIT,
    TCP_STATE_CLOSED
} tcp_state_t;

/* WebSocket Frame Structure */
typedef struct {
    int fin;
    int opcode;
    int masked;
    uint8_t mask_key[4];
    uint8_t* payload;
    size_t payload_len;
} websocket_frame_t;

/* JSON-like message structures (simplified) */
typedef struct {
    polling_msg_type_t type;
    char username[POLLING_USERNAME_LEN];
    char password[POLLING_PASSWORD_LEN];
} auth_request_t;

typedef struct {
    polling_msg_type_t type;
    int success;
    char session_token[POLLING_SESSION_TOKEN_LEN];
    char message[256];
} auth_response_t;

typedef struct {
    polling_msg_type_t type;
    uint32_t poll_id;
    uint32_t option_id;
    char session_token[POLLING_SESSION_TOKEN_LEN];
} vote_request_t;

typedef struct {
    polling_msg_type_t type;
    vote_status_t status;
    uint32_t poll_id;
    char message[256];
} vote_response_t;

/* ============================================================================
 * FUNCTION PROTOTYPES
 * ============================================================================
 */

/* Server Lifecycle */
polling_server_t* polling_server_create(uint16_t port, int max_clients);
int polling_server_start(polling_server_t* server);
void polling_server_stop(polling_server_t* server);
void polling_server_destroy(polling_server_t* server);

/* Client Handling */
void* polling_client_handler(void* arg);
int polling_client_authenticate(client_conn_t* client, auth_request_t* auth_req);
int polling_client_process_vote(client_conn_t* client, vote_request_t* vote_req);
void polling_client_disconnect(client_conn_t* client);

/* WebSocket Protocol */
int websocket_upgrade_connection(client_conn_t* client, char* handshake);
int websocket_parse_frame(const uint8_t* data, size_t len, websocket_frame_t* frame);
int websocket_create_frame(polling_msg_type_t msg_type, const char* payload,
                           uint8_t* frame_buf, size_t frame_buf_len);
void websocket_unmask_payload(uint8_t* payload, size_t len, const uint8_t* mask);

/* Database Operations */
int polling_db_init(polling_server_t* server);
int polling_db_record_vote(polling_server_t* server, const db_vote_record_t* vote);
int polling_db_check_duplicate_vote(polling_server_t* server, uint32_t user_id, uint32_t poll_id);
int polling_db_get_vote_count(polling_server_t* server, uint32_t poll_id, uint32_t option_id);
void polling_db_close(polling_server_t* server);

/* Logging (Syslog) */
void polling_log_init(const char* ident, int facility);
void polling_log_info(const char* format, ...);
void polling_log_error(const char* format, ...);
void polling_log_debug(const char* format, ...);
void polling_log_warning(const char* format, ...);

/* Socket Configuration */
int polling_socket_set_reuse(int sockfd);
int polling_socket_set_keepalive(int sockfd);
int polling_socket_set_nodelay(int sockfd);
int polling_socket_set_buffer_sizes(int sockfd);
int polling_socket_get_peer_info(int sockfd, struct sockaddr_in6* addr);

/* Authentication */
char* polling_auth_generate_token(uint32_t user_id);
int polling_auth_validate_token(const char* token);
int polling_auth_verify_credentials(const char* username, const char* password);
uint32_t polling_auth_get_user_id(const char* username);

/* Poll Management */
poll_t* polling_create_poll(uint32_t poll_id, const char* title, time_t duration);
void polling_broadcast_poll_update(polling_server_t* server, poll_t* poll);
int polling_get_poll(polling_server_t* server, uint32_t poll_id, poll_t** poll);

/* TLS/Security */
int polling_tls_init(void);
void* polling_tls_accept(int sockfd);
int polling_tls_recv(void* tls_ctx, void* buf, size_t len);
int polling_tls_send(void* tls_ctx, const void* buf, size_t len);
void polling_tls_close(void* tls_ctx);

/* State Management */
void polling_handle_tcp_states(client_conn_t* client);
void polling_detect_slow_clients(polling_server_t* server);
void polling_cleanup_stale_connections(polling_server_t* server);

#endif /* __POLLING_H__ */
