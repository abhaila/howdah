#!/usr/bin/env bash
# Start (or restart) the demo viewer on :4799 (HOWDAH_VISUAL_PORT) and the live runs, over the home that
# `bun tools/visual/seed.ts` built, plus a second viewer over the empty home on the next port. Only stops
# the processes it started itself.
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${HOWDAH_VISUAL_OUT:-${TMPDIR:-/tmp}/howdah-visual}"
for f in server.pid live.pid empty.pid; do
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
# HOW-68: a second viewer over the EMPTY home the seed also made (no runs, no workspaces, no
# proposals), on the next port, so every empty state can be shot. Its own repo copy, because
# proposals and feedback are read from the repo root, not from the home.
if [ -d "$OUT/home-empty" ] && [ -d "$OUT/repo-empty" ]; then
  EMPTY_PORT=$((PORT + 1))
  cd "$OUT/repo-empty" || exit 1
  HOWDAH_HOME="$OUT/home-empty" HOWDAH_PORT="$EMPTY_PORT" nohup bun web/server.ts > "$OUT/server-empty.log" 2>&1 < /dev/null &
  echo $! > "$OUT/empty.pid"
  for i in $(seq 1 40); do curl -sf -o /dev/null "http://localhost:$EMPTY_PORT/api/runs" && break; sleep 0.5; done
  echo "empty home: http://localhost:$EMPTY_PORT  (server pid $(cat "$OUT/empty.pid"))"
fi
