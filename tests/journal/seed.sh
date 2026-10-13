#!/bin/sh
# Seeds this machine's systemd journal with the transient units the systemd Journal integration tests expect. Run it
# (as root, or as a user who may sudo), then the tests with the POLYSCOPE_TEST_JOURNAL_COUNTER=… it prints, as a user
# who may read the system journal (in the systemd-journal or adm group) and sudo without a password, as the restart
# test does. The units keep running for the tests to read; `seed.sh --down` stops them all.
# -f: the unit names below are systemctl's patterns, not files.
set -euf

units='polyscope-counter-* polyscope-levels polyscope-failer polyscope-silent polyscope-restarter'
as_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo -n "$@"; fi; }

# Re-seeding starts the units afresh; stopping one that isn't there, or forgetting one that didn't fail, does nothing.
for unit in $units; do
  as_root systemctl stop "$unit.service" > /dev/null 2>&1 || true
  as_root systemctl reset-failed "$unit.service" > /dev/null 2>&1 || true
done
[ "${1:-}" = --down ] && exit 0

# Logs `line 1` to `line 100`, then sleeps: the Log Source contract's counter. Its lines are logged as notices, and
# messages under notice are dropped, systemd's own about the unit too (`Started …`), so its journal holds nothing else.
# The journal keeps a unit's entries after it's gone, so each seeding's counter is a unit of its own.
counter="polyscope-counter-$(date +%s)"
as_root systemd-run --quiet --unit="$counter" -p SyslogLevel=notice -p LogLevelMax=notice \
  sh -c 'i=1; while [ $i -le 100 ]; do echo "line $i"; i=$((i+1)); done; exec sleep infinity'
# Logs a line at each of several priorities, marked as syslog marks them, then sleeps.
as_root systemd-run --quiet --unit=polyscope-levels \
  sh -c 'printf "<2>reactor meltdown\n<3>disk full\n<4>low memory\n<6>all good\n<7>tick\n"; exec sleep infinity'
# Logs a line and fails, staying failed.
as_root systemd-run --quiet --unit=polyscope-failer sh -c 'echo giving up; exit 1'
# Runs without logging anything.
as_root systemd-run --quiet --unit=polyscope-silent sleep infinity
# Logs `run <its pid>` and sleeps; restarted by systemd whenever it's killed. systemd makes `$$` a `$` of its own.
as_root systemd-run --quiet --unit=polyscope-restarter -p Restart=always -p RestartSec=200ms \
  sh -c 'echo "run $$$$"; exec sleep infinity'

# Until journald has stored what the units logged, the tests could find them silent.
for _ in $(seq 1 50); do
  if journalctl --quiet --unit="$counter.service" --grep='^line 100$' > /dev/null 2>&1 &&
    journalctl --quiet --unit=polyscope-failer.service --grep='^giving up$' > /dev/null 2>&1; then
    echo "POLYSCOPE_TEST_JOURNAL_COUNTER=$counter.service"
    exit 0
  fi
  sleep 0.2
done
echo "The seeded units' lines never reached the journal" >&2
exit 1
