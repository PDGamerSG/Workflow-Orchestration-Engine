#!/usr/bin/env bash
# Starts the engine and the dashboard together and stops both when either one exits.
set -u

web_port="${PORT:-3000}"
cd "$(dirname "$0")/.."

(cd server && PORT="${ENGINE_PORT:-4000}" exec bun src/index.ts) &
engine=$!
(cd web && exec node_modules/.bin/next start --port "$web_port" --hostname 0.0.0.0) &
web=$!

stopping=0
stop() { kill -TERM "$engine" "$web" 2>/dev/null; }
trap 'stopping=1; stop' TERM INT

# Polled rather than `wait -n`, which the bash that ships with macOS does not have.
while kill -0 "$engine" 2>/dev/null && kill -0 "$web" 2>/dev/null; do
  sleep 1 & wait $!
done
stop
wait "$engine"; engine_status=$?
wait "$web"; web_status=$?
# A requested stop is a clean exit even though Next.js reports the signal in its status.
[ "$stopping" = 1 ] && exit 0
exit $((engine_status || web_status))
