#!/bin/sh
# Seeds the default context's Docker Engine with what the Docker Logs integration tests expect: the Compose project in
# compose.yaml, and standalone containers outside Compose. Run it, then the tests with POLYSCOPE_TEST_DOCKER=seeded.
# The containers keep running for the tests to read; `seed.sh --down` removes them all.
set -eu
cd "$(dirname "$0")"

standalone='polyscope-counter polyscope-ticker polyscope-done polyscope-crasher polyscope-unhealthy polyscope-syslog'

if [ "${1:-}" = --down ]; then
  docker compose -f compose.yaml down
  # shellcheck disable=SC2086 # one name each
  docker rm -f $standalone > /dev/null 2>&1 || true
  exit 0
fi

docker compose -f compose.yaml up -d --wait

# Re-seeding starts the standalone containers afresh.
# shellcheck disable=SC2086 # one name each
docker rm -f $standalone > /dev/null 2>&1 || true
# Logs `line 1` to `line 100`, then sleeps: the Log Source contract's counter.
docker run -d --name polyscope-counter busybox:1.36 \
  sh -c 'i=1; while [ $i -le 100 ]; do echo "line $i"; i=$((i+1)); done; exec sleep 3600000' > /dev/null
# Logs `tick 1`, `tick 2`… a second apart, for good, for Follow.
docker run -d --name polyscope-ticker busybox:1.36 \
  sh -c 'i=1; while true; do echo "tick $i"; i=$((i+1)); sleep 1; done' > /dev/null
# Ran and exited, so it's stopped but still listed.
docker run --name polyscope-done busybox:1.36 sh -c 'echo all done' > /dev/null

# Crashes every 10 seconds and is restarted at once: a run that lasted 10 s resets the engine's back-off.
docker run -d --name polyscope-crasher --restart always busybox:1.36 \
  sh -c 'echo "run started"; sleep 10; echo crashing; exit 1' > /dev/null
# Fails its healthcheck from the first try.
docker run -d --name polyscope-unhealthy --health-cmd false --health-interval 1s --health-retries 1 busybox:1.36 \
  sh -c 'echo up; exec sleep 3600000' > /dev/null
# Logs to syslog, with no copy kept for `docker logs` to read back. Nothing need listen: it's sent over UDP.
docker run -d --name polyscope-syslog --log-driver syslog --log-opt syslog-address=udp://127.0.0.1:514 \
  --log-opt cache-disabled=true busybox:1.36 sh -c 'echo shipped; exec sleep 3600000' > /dev/null

# Waits up to 30 s for a condition (the rest of the arguments) to hold, or fails saying what never happened ($1).
wait_for() {
  what=$1
  shift
  for _ in $(seq 1 30); do
    "$@" && return 0
    sleep 1
  done
  echo "$what" >&2
  exit 1
}

counted() { [ "$(docker logs polyscope-counter 2>&1 | wc -l)" -ge 100 ]; }
restarted() { [ "$(docker inspect -f '{{.RestartCount}}' polyscope-crasher)" -ge 1 ]; }
unhealthy() { [ "$(docker inspect -f '{{.State.Health.Status}}' polyscope-unhealthy)" = unhealthy ]; }

# The counter's lines are in its log once it's sleeping.
wait_for 'polyscope-counter never logged its 100 lines' counted
wait_for 'polyscope-crasher never restarted' restarted
wait_for 'polyscope-unhealthy never failed its healthcheck' unhealthy
