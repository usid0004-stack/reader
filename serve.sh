#!/bin/sh
# Serve the reader on your local Wi-Fi so a phone can open it.
# Your computer must stay awake and on the same network while you use it.
cd "$(dirname "$0")" || exit 1
PORT="${1:-8765}"
IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"
echo "Reader is running."
echo "  On this computer:  http://localhost:${PORT}/"
if [ -n "$IP" ]; then
  echo "  On your phone:     http://${IP}:${PORT}/   (same Wi-Fi only)"
else
  echo "  On your phone:     http://<this computer's Wi-Fi IP>:${PORT}/"
fi
echo "Press Ctrl+C to stop."
exec python3 -m http.server "$PORT" --bind 0.0.0.0
