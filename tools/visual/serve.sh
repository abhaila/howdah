#!/usr/bin/env bash
# Start (or restart) the demo viewer on :4799 (HOWDAH_VISUAL_PORT) and the one live run, over the home that
# `bun tools/visual/seed.ts` built. Only stops the two processes it started itself.
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${HOWDAH_VISUAL_OUT:-${TMPDIR:-/tmp}/howdah-visual}"
for f in server.pid live.pid; do
  if [ -f "$OUT/$f" ]; then kill "$(cat "$OUT/$f")" 2>/dev/null; rm -f "$OUT/$f"; fi
done
[ "$1" = "stop" ] && exit 0
sleep 1
PORT="${HOWDAH_VISUAL_PORT:-4799}"
export HOWDAH_HOME="$OUT/home" HOWDAH_PORT="$PORT" HOWDAH_VISUAL_OUT="$OUT"
# `cd` on its own line: `cd X && nohup … &` backgrounds a SUBSHELL, so $! was the wrong pid and
# `stop` left the real server holding the port
cd "$HERE" || exit 1
nohup bun live.ts > "$OUT/live.log" 2>&1 < /dev/null &
echo $! > "$OUT/live.pid"
# served from the private repo copy the seed made: the server bundles into web/public and
# writes proposals/feedback under its repo root, and none of that belongs in the working tree
cd "$OUT/repo" || exit 1
nohup bun web/server.ts > "$OUT/server.log" 2>&1 < /dev/null &
echo $! > "$OUT/server.pid"
for i in $(seq 1 40); do curl -sf -o /dev/null "http://localhost:$PORT/api/runs" && break; sleep 0.5; done
echo "viewer: http://localhost:$PORT  (server pid $(cat "$OUT/server.pid"), live-run pid $(cat "$OUT/live.pid"))"
