#!/bin/sh
# Reaches the default context's Docker Engine over SSH, as an `ssh://` context does: an OpenSSH sshd on 127.0.0.1:2222,
# running as this user with keys generated here, so `docker system dial-stdio` runs as this user, who must be able to
# use the engine. A Docker context, polyscope-test-ssh, names it. Run it after seed.sh, then the tests with
# POLYSCOPE_TEST_DOCKER_SSH_CONTEXT=polyscope-test-ssh, with POLYSCOPE_TEST_DOCKER_SSH_DIR set as it was here: the folder
# (/tmp/polyscope-docker-ssh unless it's set) holding the key that signs in (client_key) and a known_hosts line for the
# server's host key. Nothing in ~/.ssh is touched. `ssh.sh --down` stops sshd and removes the context and the folder.
set -eu

context=polyscope-test-ssh
dir="${POLYSCOPE_TEST_DOCKER_SSH_DIR:-/tmp/polyscope-docker-ssh}"
port=2222

if [ -f "$dir/sshd.pid" ]; then kill "$(cat "$dir/sshd.pid")" 2> /dev/null || true; fi
docker context rm -f "$context" > /dev/null 2>&1 || true
rm -rf "$dir"
if [ "${1:-}" = --down ]; then exit 0; fi

mkdir -p "$dir"
ssh-keygen -q -t ed25519 -N '' -f "$dir/host_key"
ssh-keygen -q -t ed25519 -N '' -f "$dir/client_key"
cp "$dir/client_key.pub" "$dir/authorized_keys"
user=$(whoami)
cat > "$dir/sshd_config" << EOF
ListenAddress 127.0.0.1
Port $port
HostKey $dir/host_key
PidFile $dir/sshd.pid
AuthorizedKeysFile $dir/authorized_keys
AllowUsers $user
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
StrictModes no
EOF
# sshd wants its privilege separation folder, even run as an ordinary user.
[ -d /run/sshd ] || sudo mkdir -p /run/sshd
/usr/sbin/sshd -f "$dir/sshd_config" -E "$dir/sshd.log"
echo "[127.0.0.1]:$port $(cat "$dir/host_key.pub")" > "$dir/known_hosts"

docker context create "$context" --description 'The test engine, over SSH (tests/docker/ssh.sh)' --docker "host=ssh://$user@127.0.0.1:$port" > /dev/null

# Waits up to 30 s for the engine to answer through sshd, as Polyscope reaches it.
for _ in $(seq 1 30); do
  ssh -i "$dir/client_key" -o UserKnownHostsFile="$dir/known_hosts" -o BatchMode=yes -p "$port" "$user@127.0.0.1" docker version > /dev/null 2>&1 && exit 0
  sleep 1
done
echo "The engine never answered over SSH" >&2
cat "$dir/sshd.log" >&2
exit 1
