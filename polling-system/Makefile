# ============================================================================
# WEBSOCKET LIVE POLLING SYSTEM - MAKEFILE
# ============================================================================
#
# Compilation targets:
#  - polling_server: Main server application
#  - test_polling: Comprehensive test suite
#  - clean: Remove build artifacts
#
# Requirements:
#  - GCC/Clang with C99 support
#  - OpenSSL development libraries (libssl-dev)
#  - Cosmos prechecks use standard socket/DNS libraries (no sqlite3-dev)
#  - POSIX threads (pthreads)
#
# On Ubuntu/Debian:
#  sudo apt-get install libssl-dev
#
# On macOS:
#  brew install openssl

CC           = gcc
CFLAGS       = -Wall -Wextra -std=c99 -Iinclude -g -O2
LDFLAGS      = -lpthread -lssl -lcrypto -lm
WARNINGS     = -Wpedantic -Wshadow -Wunreachable-code

# Source files
SERVER_SRCS  = src/polling_server.c src/polling_websocket.c src/polling_db.c \
               src/polling_auth.c src/polling_util.c src/polling_tls.c
TEST_SRCS    = tests/test_polling.c

# Build targets
SERVER_OBJ   = $(SERVER_SRCS:.c=.o)
TEST_OBJ     = $(TEST_SRCS:.c=.o)

# Executable names
SERVER_BIN   = polling_server
TEST_BIN     = test_polling

all: $(SERVER_BIN) $(TEST_BIN)

# ============================================================================
# SERVER BUILD
# ============================================================================

$(SERVER_BIN): $(SERVER_OBJ)
	@echo "[LD] Linking $@..."
	@$(CC) $(CFLAGS) -o $@ $^ $(LDFLAGS)
	@echo "[OK] Server built: $@"

# ============================================================================
# TEST BUILD
# ============================================================================

$(TEST_BIN): $(TEST_OBJ)
	@echo "[LD] Linking $@..."
	@$(CC) $(CFLAGS) -o $@ $^ $(LDFLAGS)
	@echo "[OK] Tests built: $@"

# ============================================================================
# OBJECT FILES
# ============================================================================

%.o: %.c
	@echo "[CC] Compiling $<..."
	@$(CC) $(CFLAGS) $(WARNINGS) -c $< -o $@

# ============================================================================
# TARGETS
# ============================================================================

run-server: $(SERVER_BIN)
	@echo "[EXEC] Starting polling server..."
	./$(SERVER_BIN) -p 8443 -c 1024
	@echo "[DONE] Server stopped"

run-tests: $(TEST_BIN)
	@echo "[EXEC] Running test suite..."
	./$(TEST_BIN)

coverage:
	@echo "[INFO] Code coverage analysis (requires gcov):"
	@for src in $(SERVER_SRCS); do \
		echo "  $$src: Need to implement coverage instrumentation"; \
	done

clean:
	@echo "[RM] Cleaning build artifacts..."
	rm -f $(SERVER_OBJ) $(TEST_OBJ)
	rm -f $(SERVER_BIN) $(TEST_BIN)
	rm -f *.o src/*.o tests/*.o
	rm -f /var/lib/polling/votes.db /var/lib/polling/votes.db-shm /var/lib/polling/votes.db-wal
	@echo "[OK] Cleaned"

install: $(SERVER_BIN)
	@echo "[INSTALL] Installing polling server..."
	sudo mkdir -p /usr/local/bin /var/lib/polling /etc/polling
	sudo cp $(SERVER_BIN) /usr/local/bin/
	sudo chown root:root /usr/local/bin/$(SERVER_BIN)
	sudo chmod 755 /usr/local/bin/$(SERVER_BIN)
	@echo "[OK] Installed"

.PHONY: all run-server run-tests coverage clean install
