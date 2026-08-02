#!/usr/bin/env bash
set -euo pipefail
ROOT=/root/cloud189-auto-save
LOG=$ROOT/logs/dev-50001.log
PIDFILE=$ROOT/logs/dev-50001.pid

mkdir -p "$ROOT/logs"
ln -sfn /opt/cloud189/data "$ROOT/data"
ln -sfn /opt/cloud189/strm "$ROOT/strm"
ln -sfn /opt/cloud189/strm /root/strm

if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "already running pid=$(cat "$PIDFILE")"
  exit 0
fi

if ss -lntp | grep -q ':50001'; then
  fuser -k 50001/tcp 2>/dev/null || true
  sleep 1
fi

cd "$ROOT"
setsid env \
  PORT=50001 \
  EMBY_PROXY_PORT=50004 \
  PUID=0 \
  PGID=0 \
  DNS_LOOKUP_IP_VERSION=ipv4 \
  PUBLIC_BASE_URL=http://192.168.23.161:50001 \
  NODE_ENV=production \
  node "$ROOT/dist/index.js" \
  >"$LOG" 2>&1 < /dev/null &
echo $! >"$PIDFILE"
sleep 2
ss -lntp | grep 50001 || { echo 'bind failed'; tail -n 50 "$LOG"; exit 1; }
echo "started pid=$(cat "$PIDFILE") -> http://0.0.0.0:50001"
