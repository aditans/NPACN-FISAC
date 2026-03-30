/*
 * ============================================================================
 * POLLING SYSTEM - WEBSOCKET PROTOCOL IMPLEMENTATION
 * ============================================================================
 *
 * Implements WebSocket protocol (RFC 6455) with:
 * - HTTP upgrade handshake (GET → 101 Switching Protocols)
 * - TLS/SSL negotiation (secure WebSocket over TLS)
 * - Frame encoding/decoding (payload masking)
 * - Message type handling (control frames, data frames)
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <ctype.h>
#include <openssl/sha.h>
#include <openssl/bio.h>
#include <openssl/buffer.h>
#include <errno.h>
#include "../include/polling.h"

/* ============================================================================
 * BASE64 ENCODING (for Sec-WebSocket-Accept header)
 * ============================================================================
 */

static const char base64_table[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static int base64_encode(const unsigned char* input, int input_len,
                        char* output, int output_max) {
    int i, j = 0;
    unsigned char byte1, byte2, byte3;

    for (i = 0; i < input_len; i += 3) {
        byte1 = input[i];
        byte2 = (i + 1 < input_len) ? input[i + 1] : 0;
        byte3 = (i + 2 < input_len) ? input[i + 2] : 0;

        if (j + 4 > output_max) return -1;

        output[j++] = base64_table[byte1 >> 2];
        output[j++] = base64_table[((byte1 & 0x03) << 4) | (byte2 >> 4)];

        if (i + 1 < input_len) {
            output[j++] = base64_table[((byte2 & 0x0F) << 2) | (byte3 >> 6)];
        } else {
            output[j++] = '=';
        }

        if (i + 2 < input_len) {
            output[j++] = base64_table[byte3 & 0x3F];
        } else {
            output[j++] = '=';
        }
    }

    output[j] = '\0';
    return j;
}

/* ============================================================================
 * WEBSOCKET HANDSHAKE - HTTP UPGRADE PROCESS
 * ============================================================================
 *
 * WebSocket Upgrade (RFC 6455):
 *
 * CLIENT → SERVER (HTTP GET with upgrade headers):
 * GET /ws HTTP/1.1
 * Host: server.example.com:8443
 * Upgrade: websocket
 * Connection: Upgrade
 * Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
 * Sec-WebSocket-Version: 13
 * [Custom Auth Headers]
 *
 * SERVER → CLIENT (HTTP 101 response):
 * HTTP/1.1 101 Switching Protocols
 * Upgrade: websocket
 * Connection: Upgrade
 * Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
 *
 * After this point, TCP connection switches to WebSocket binary framing (RFC 6455).
 *
 * The Sec-WebSocket-Accept is computed as:
 * Base64(SHA1(Sec-WebSocket-Key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
 */

int websocket_upgrade_connection(client_conn_t* client, char* handshake) {
    char sec_websocket_key[128] = {0};
    char response[1024] = {0};
    unsigned char sha_digest[20];
    char accept_key[32];
    char* key_start;
    char* key_end;
    int key_len;
    SHA_CTX sha_ctx;
    char combined_string[256];

    polling_log_debug("WebSocket upgrade handshake initiated for client fd=%d",
                     client->socket_fd);

    /* Extract Sec-WebSocket-Key from handshake */
    key_start = strstr(handshake, "Sec-WebSocket-Key: ");
    if (!key_start) {
        polling_log_error("Missing Sec-WebSocket-Key in handshake");
        return -1;
    }

    key_start += strlen("Sec-WebSocket-Key: ");
    key_end = strchr(key_start, '\r');
    if (!key_end) key_end = strchr(key_start, '\n');

    key_len = key_end ? (key_end - key_start) : strlen(key_start);
    if (key_len >= sizeof(sec_websocket_key)) {
        polling_log_error("Sec-WebSocket-Key too long");
        return -1;
    }

    strncpy(sec_websocket_key, key_start, key_len);
    polling_log_debug("Sec-WebSocket-Key: %s", sec_websocket_key);

    /* Compute Sec-WebSocket-Accept = Base64(SHA1(key + magic_string)) */
    snprintf(combined_string, sizeof(combined_string), "%s%s",
            sec_websocket_key, WEBSOCKET_MAGIC_STRING);

    SHA1_Init(&sha_ctx);
    SHA1_Update(&sha_ctx, (unsigned char*)combined_string, strlen(combined_string));
    SHA1_Final(sha_digest, &sha_ctx);

    base64_encode(sha_digest, sizeof(sha_digest), accept_key, sizeof(accept_key));
    polling_log_debug("Sec-WebSocket-Accept: %s", accept_key);

    /* Build HTTP 101 response */
    snprintf(response, sizeof(response),
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Accept: %s\r\n"
            "\r\n",
            accept_key);

    /* Send upgrade response */
    if (send(client->socket_fd, response, strlen(response), 0) < 0) {
        polling_log_error("Failed to send WebSocket upgrade response: %s", strerror(errno));
        return -1;
    }

    client->bytes_sent += strlen(response);
    client->websocket_upgraded = 1;
    client->state = CLIENT_STATE_AUTHENTICATING;

    polling_log_info("WebSocket upgrade complete for client fd=%d", client->socket_fd);
    return 0;
}

/* ============================================================================
 * WEBSOCKET FRAME PARSING (RFC 6455 Section 5.2)
 * ============================================================================
 *
 * WebSocket Frame Structure:
 *
 *  0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
 * +-+-+-+-+-------+-+-------------+-------------------------------+
 * |F|R|R|R| opcode|M| Payload len |    Extended payload length    |
 * |I|S|S|S|(4bits)|A|     (7)     |             (0/16/64)         |
 * |N|V|V|V|       |S|             |   (ONLY if payload len==126/127)|
 * | |1|2|3|       |K|             |                               |
 * +-+-+-+-+-------+-+-------------+ - - - - - - - - - - - - - - - +
 * |     Extended payload length continued, if payload len == 127  |
 * + - - - - - - - - - - - - - - - +-------------------------------+
 * |                          Masking-key (0 or 4 octets)           |
 * +-------------------------------+-------------------------------+
 * :                     Payload Data (x+y octets)                  :
 * +---------------------------------------------------------------+
 *
 * FIN: 1 = Final fragment, 0 = More coming
 * Opcode: 0x0 (continuation), 0x1 (text), 0x2 (binary), 0x8 (close),
 *         0x9 (ping), 0xA (pong)
 * MASK: 1 = payload masked (client → server), 0 = unmasked (server → client)
 * [Masking key]: 4 bytes XOR mask (present if MASK=1)
 * Payload: Masked with masking_key if MASK=1
 *
 * Error handling:
 * - MUST handle partial frames (recv may return < frame size)
 * - MUST verify FIN=1 before processing
 * - MUST validate opcode (reserved opcodes = error)
 */

int websocket_parse_frame(const uint8_t* data, size_t len, websocket_frame_t* frame) {
    size_t header_len = 2;  /* Minimum header size */
    uint64_t payload_len;
    uint8_t len_byte;

    if (!data || !frame || len < 2) {
        return -1;  /* Incomplete header */
    }

    /* Byte 0: FIN (bit 7) + OPCODE (bits 3-0) */
    frame->fin = (data[0] >> 7) & 1;
    frame->opcode = data[0] & 0x0F;

    /* Byte 1: MASK (bit 7) + Payload length (bits 6-0) */
    frame->masked = (data[1] >> 7) & 1;
    len_byte = data[1] & 0x7F;

    /* Determine payload length */
    if (len_byte < 126) {
        payload_len = len_byte;
    } else if (len_byte == 126) {
        /* 16-bit big-endian payload length follows */
        if (len < 4) return -1;  /* Incomplete */
        payload_len = ((uint64_t)data[2] << 8) | data[3];
        header_len = 4;
    } else {  /* len_byte == 127 */
        /* 64-bit big-endian payload length follows */
        if (len < 10) return -1;  /* Incomplete */
        payload_len = 0;
        for (int i = 0; i < 8; i++) {
            payload_len = (payload_len << 8) | data[2 + i];
        }
        header_len = 10;
    }

    /* Masking key (if MASK=1) */
    if (frame->masked) {
        if (len < header_len + 4) return -1;  /* Incomplete */
        memcpy(frame->mask_key, &data[header_len], 4);
        header_len += 4;
    }

    /* Check complete frame */
    if (len < header_len + payload_len) {
        return -1;  /* Incomplete frame */
    }

    /* Extract payload */
    frame->payload_len = payload_len;
    if (payload_len > 0) {
        frame->payload = (uint8_t*)&data[header_len];
    }

    return (int)(header_len + payload_len);  /* Bytes consumed */
}

/* ============================================================================
 * PAYLOAD MASKING (RFC 6455 Section 5.3)
 * ============================================================================
 *
 * XOR unmask operation (same as mask, since XOR(XOR(x, k), k) = x):
 * transformed_octet[i] = original_octet[i] XOR masking_key[i % 4]
 */

void websocket_unmask_payload(uint8_t* payload, size_t len, const uint8_t* mask) {
    for (size_t i = 0; i < len; i++) {
        payload[i] ^= mask[i % 4];
    }
}

/* ============================================================================
 * WEBSOCKET FRAME CREATION (Server → Client, unmasked)
 * ============================================================================
 */

int websocket_create_frame(polling_msg_type_t msg_type, const char* payload,
                          uint8_t* frame_buf, size_t frame_buf_len) {
    size_t payload_len = payload ? strlen(payload) : 0;
    uint8_t opcode = 0x01;  /* Text frame */
    size_t header_len = 2;
    size_t total_len;

    if (payload_len > MAX_FRAME_PAYLOAD_SIZE) {
        return -1;
    }

    /* Determine header size based on payload length */
    if (payload_len < 126) {
        header_len = 2;
    } else if (payload_len < 65536) {
        header_len = 4;
    } else {
        header_len = 10;
    }

    total_len = header_len + payload_len;
    if (total_len > frame_buf_len) {
        return -1;
    }

    /* Byte 0: FIN=1 (0x80) + Opcode (0x01 for text) */
    frame_buf[0] = 0x80 | opcode;

    /* Byte 1 + extended length: MASK=0 (server) + payload length */
    if (payload_len < 126) {
        frame_buf[1] = payload_len;
    } else if (payload_len < 65536) {
        frame_buf[1] = 126;
        frame_buf[2] = (payload_len >> 8) & 0xFF;
        frame_buf[3] = payload_len & 0xFF;
    } else {
        frame_buf[1] = 127;
        for (int i = 0; i < 8; i++) {
            frame_buf[2 + i] = (payload_len >> (56 - i * 8)) & 0xFF;
        }
    }

    /* Copy payload */
    if (payload_len > 0) {
        memcpy(&frame_buf[header_len], payload, payload_len);
    }

    return (int)total_len;
}

/* ============================================================================
 * CONTROL FRAME HANDLERS
 * ============================================================================
 */

int websocket_handle_ping(client_conn_t* client) {
    /* Send PONG response (opcode 0xA) */
    uint8_t pong_frame[2] = {0x8A, 0x00};  /* FIN + PONG, no payload */
    if (send(client->socket_fd, pong_frame, sizeof(pong_frame), 0) < 0) {
        polling_log_error("Failed to send PONG: %s", strerror(errno));
        return -1;
    }
    client->bytes_sent += sizeof(pong_frame);
    return 0;
}

int websocket_handle_close(client_conn_t* client) {
    /* Send CLOSE frame response (opcode 0x8) */
    uint8_t close_frame[2] = {0x88, 0x00};  /* FIN + CLOSE, no payload */
    send(client->socket_fd, close_frame, sizeof(close_frame), 0);
    client->bytes_sent += sizeof(close_frame);
    return -1;  /* Signal to close connection */
}
