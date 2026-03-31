# save as send_malformed.py
import socket, base64, hashlib
host='127.0.0.1'; port=8080
s=socket.socket()
s.connect((host,port))
# send naive HTTP upgrade (no real mask) to get to WebSocket or reuse an already-upgraded connection
s.send(b"GET /polling/ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: xxxxxxxxxxxxx\r\nSec-WebSocket-Version: 13\r\n\r\n")
print(s.recv(4096))
# If server upgraded, send an invalid frame (incorrect length/mask)
s.send(b'\\x89\\xFFbadframe')  # invalid opcode/payload
s.close()
