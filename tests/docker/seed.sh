#!/bin/sh
# Seeds the default context's Docker Engine with what the Docker Logs integration tests expect: the Compose project in
# compose.yaml, and standalone containers outside Compose. Run it, then the tests with POLYSCOPE_TEST_DOCKER=seeded.
# The containers keep running for the tests to read; `seed.sh --down` removes them all.
set -eu
cd "$(dirname "$0")"

standalone='polyscope-counter polyscope-ticker polyscope-done'

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

# The counter's lines are in its log once it's sleeping.
for _ in $(seq 1 30); do
  [ "$(docker logs polyscope-counter 2>&1 | wc -l)" -ge 100 ] && exit 0
  sleep 1
done
echo 'polyscope-counter never logged its 100 lines' >&2
exit 1
