#!/bin/sh
# Starts an OpenSSH sshd for the SSH integration tests (SSH Files, and systemd Journal on a host): running as this user
# on 127.0.0.1:2222, unprivileged, with keys generated here, so none are ever committed, in a folder of its own
# ($RUNNER_TEMP/sshd in CI, /tmp/polyscope-sshd elsewhere). It prints the POLYSCOPE_TEST_SSHD_*=… settings the tests
# read, one per line, for CI to add to $GITHUB_ENV. Nothing in ~/.ssh is touched. `sshd.sh --down` stops it and removes
# its folder.
set -eu

if [ -n "${RUNNER_TEMP:-}" ]; then dir="$RUNNER_TEMP/sshd"; else dir=/tmp/polyscope-sshd; fi
host=127.0.0.1
port=2222

# Started afresh: one this started before is stopped, and its folder removed.
if [ -f "$dir/sshd.pid" ]; then kill "$(cat "$dir/sshd.pid")" 2> /dev/null || true; fi
rm -rf "$dir"
if [ "${1:-}" = --down ]; then exit 0; fi
mkdir -p "$dir/root"
ssh-keygen -q -t ed25519 -N '' -f "$dir/host_key" > /dev/null
ssh-keygen -q -t ed25519 -N '' -f "$dir/client_key" > /dev/null
cp "$dir/client_key.pub" "$dir/authorized_keys"
cat > "$dir/sshd_config" << EOF2
ListenAddress $host
Port $port
HostKey $dir/host_key
PidFile $dir/sshd.pid
AuthorizedKeysFile $dir/authorized_keys
AllowUsers $(whoami)
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
StrictModes no
Subsystem sftp internal-sftp
EOF2
# sshd wants its privilege separation folder, even run as an ordinary user.
[ -d /run/sshd ] || sudo mkdir -p /run/sshd
/usr/sbin/sshd -f "$dir/sshd_config" -E "$dir/sshd.log"
for _ in $(seq 1 30); do ssh-keyscan -p "$port" "$host" > /dev/null 2>&1 && break; sleep 1; done

echo "POLYSCOPE_TEST_SSHD_HOST=$host"
echo "POLYSCOPE_TEST_SSHD_PORT=$port"
echo "POLYSCOPE_TEST_SSHD_USER=$(whoami)"
echo "POLYSCOPE_TEST_SSHD_KEY=$dir/client_key"
echo "POLYSCOPE_TEST_SSHD_HOST_KEY=$dir/host_key.pub"
echo "POLYSCOPE_TEST_SSHD_ROOT=$dir/root"
