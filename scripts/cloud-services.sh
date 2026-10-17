#!/bin/sh
# Starts the real backends the integration tests run against, in a Claude Code cloud session, as CI's integration jobs
# do one per job (.github/workflows/ci.yml): RustFS for S3, Azurite for Azure Blob Storage, an OpenSSH sshd for SSH
# Files, the seeded Docker Engine (over its socket, TLS and SSH), the seeded systemd journal where systemd runs, and a
# seeded kind cluster for Kubernetes. Each service's POLYSCOPE_TEST_* settings go into $dir/env once it's up, so a
# test whose backend isn't ready yet is skipped rather than failed.
#
# The cloud environment's setup script installs the tools (Node 24, RustFS, kind, kubectl, sshd); this only starts
# them, since a cached environment keeps files, not running processes.
#
# `cloud-services.sh` starts everything in the foreground, ending with $dir/done, and $dir/failed naming the services
# that didn't start, if any did. `cloud-services.sh --session-start` is the SessionStart hook in .claude/settings.json:
# outside a cloud session it does nothing; in one it has Claude's shell commands read $dir/env, and starts everything in
# the background, logging to $dir/log, unless it's already running or done since the VM last started.
set -u

dir=/tmp/polyscope-cloud
env="$dir/env"
self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$self")/.."

if [ "${1:-}" = --session-start ]; then
  [ "${CLAUDE_CODE_REMOTE:-}" = true ] || exit 0
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    # The VM puts Node 22 on PATH; CI's 24 is in /opt/node24, where the environment's setup script installs it.
    echo 'export PATH="/opt/node24/bin:$PATH"' >> "$CLAUDE_ENV_FILE"
    echo "if [ -f $env ]; then . $env; fi" >> "$CLAUDE_ENV_FILE"
  fi
  if [ -f "$dir/pid" ] && kill -0 "$(cat "$dir/pid")" 2> /dev/null; then
    echo "The integration test backends are still starting (scripts/cloud-services.sh, logging to $dir/log)."
    exit 0
  fi
  # A VM restored after being idle keeps the files but not the processes: the engine stopped tells which.
  if [ -f "$dir/done" ] && docker info > /dev/null 2>&1; then
    echo "The integration test backends were started (scripts/cloud-services.sh, logged to $dir/log); their settings" \
      "are in $env.$( [ -f "$dir/failed" ] && echo " These didn't start: $(cat "$dir/failed").")"
    exit 0
  fi
  mkdir -p "$dir"
  setsid "$self" > "$dir/log" 2>&1 < /dev/null &
  echo $! > "$dir/pid"
  echo "The integration test backends are starting in the background (scripts/cloud-services.sh, logging to" \
    "$dir/log), which takes a few minutes. $dir/done appears when it's finished, with $dir/failed naming any" \
    "that didn't start. Until then the integration tests skip the services that aren't up yet."
  exit 0
fi

PATH="/opt/node24/bin:$PATH"

# Started afresh: the settings of a run before are dropped, so none points at a service that's gone.
rm -f "$env" "$dir/done" "$dir/failed"
mkdir -p "$dir"
: > "$env"

put() { printf "export %s='%s'\n" "$1" "$2" >> "$env"; }
# Waits up to $1 seconds for the command after it to succeed.
wait_for() {
  seconds=$1
  shift
  for _ in $(seq 1 "$seconds"); do "$@" > /dev/null 2>&1 && return 0; sleep 1; done
  return 1
}

dependencies() {
  # npm ci again only when the lockfile changed since it last ran.
  hash=$(sha256sum package-lock.json)
  [ -f node_modules/.package-lock.sha256 ] && [ "$(cat node_modules/.package-lock.sha256)" = "$hash" ] && return 0
  npm ci
  echo "$hash" > node_modules/.package-lock.sha256
}

engine() {
  if ! docker info > /dev/null 2>&1; then
    nohup dockerd > "$dir/dockerd.log" 2>&1 &
    wait_for 60 docker info || { cat "$dir/dockerd.log"; return 1; }
  fi
}

s3() {
  pkill -f 'rustfs server' 2> /dev/null || true
  rm -rf "$dir/rustfs-data"
  mkdir -p "$dir/rustfs-data"
  nohup rustfs server --address 127.0.0.1:9000 --access-key polyscope --secret-key polyscope-secret \
    "$dir/rustfs-data" > "$dir/rustfs.log" 2>&1 &
  wait_for 60 curl -sf http://127.0.0.1:9000/health || { cat "$dir/rustfs.log"; return 1; }
  put POLYSCOPE_TEST_S3_ENDPOINT http://127.0.0.1:9000
  put POLYSCOPE_TEST_S3_ACCESS_KEY polyscope
  put POLYSCOPE_TEST_S3_SECRET_KEY polyscope-secret
}

# As in CI's integration (Azure Blob Storage) job: Azurite over https, with a certificate made here the tests trust.
azure() {
  certs="$dir/azurite"
  docker rm -f azurite > /dev/null 2>&1 || true
  rm -rf "$certs"
  mkdir -p "$certs"
  openssl req -x509 -newkey rsa:2048 -nodes -keyout "$certs/key.pem" -out "$certs/cert.pem" -days 30 \
    -subj /CN=127.0.0.1 -addext subjectAltName=IP:127.0.0.1,DNS:localhost 2> /dev/null
  chmod 644 "$certs/key.pem"
  docker run -d --name azurite -p 127.0.0.1:10000:10000 -v "$certs:/certs:ro" \
    mcr.microsoft.com/azure-storage/azurite:3.37.0@sha256:830430c1da1a2d537e08f3e6764dd1f5ae00cf0346bcaf625b968ec3f0971fd5 \
    azurite-blob --blobHost 0.0.0.0 --skipApiVersionCheck --oauth basic --cert /certs/cert.pem --key /certs/key.pem \
    > /dev/null
  if ! wait_for 60 curl -s -o /dev/null --cacert "$certs/cert.pem" https://127.0.0.1:10000/; then
    docker logs azurite
    return 1
  fi
  # Azurite's published development account and key, not a secret.
  put POLYSCOPE_TEST_AZURE_CONNECTION_STRING 'DefaultEndpointsProtocol=https;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=https://127.0.0.1:10000/devstoreaccount1;'
  put POLYSCOPE_TEST_AZURE_OAUTH 1
  put NODE_EXTRA_CA_CERTS "$certs/cert.pem"
}

ssh_files() {
  tests/ssh/sshd.sh > "$dir/sshd.env"
  sed 's/^/export /' "$dir/sshd.env" >> "$env"
}

# tests/docker/ssh.sh's sshd takes 2223, as tests/ssh/sshd.sh's has 2222.
docker_logs() {
  tests/docker/seed.sh
  tests/docker/tls.sh
  POLYSCOPE_TEST_DOCKER_SSH_DIR=/tmp/polyscope-docker-ssh POLYSCOPE_TEST_DOCKER_SSH_PORT=2223 tests/docker/ssh.sh
  put POLYSCOPE_TEST_DOCKER seeded
  put POLYSCOPE_TEST_DOCKER_TLS_CONTEXT polyscope-test-tls
  put POLYSCOPE_TEST_DOCKER_SSH_CONTEXT polyscope-test-ssh
  put POLYSCOPE_TEST_DOCKER_SSH_DIR /tmp/polyscope-docker-ssh
}

journal() {
  if [ "$(cat /proc/1/comm)" != systemd ]; then
    echo "systemd isn't running this machine, so there's no journal to seed"
    return 1
  fi
  tests/journal/seed.sh > "$dir/journal.env"
  sed 's/^/export /' "$dir/journal.env" >> "$env"
}

# As in CI's integration (Kubernetes) job; a cluster left from before is made afresh, its pods gone with the VM.
kubernetes() {
  kind delete cluster --name polyscope > /dev/null 2>&1 || true
  kind create cluster --name polyscope --wait 180s
  # The seed's images, given to the cluster from the engine, so its pods never pull through the session's proxy.
  for image in busybox:1.36 debian:bookworm-slim registry.k8s.io/pause:3.10; do
    docker image inspect "$image" > /dev/null 2>&1 || docker pull "$image"
  done
  kind load docker-image --name polyscope busybox:1.36 debian:bookworm-slim registry.k8s.io/pause:3.10
  # A bare pod isn't retried like a Workload's: its namespace's default ServiceAccount has to be there first.
  kubectl create namespace polyscope-test
  kubectl -n polyscope-test wait --for=create serviceaccount/default --timeout=60s
  kubectl apply -f tests/kind/seed.yaml
  # The CronJob never comes due by itself; one run gives it a Job.
  kubectl -n polyscope-test create job nightly-manual --from=cronjob/nightly
  kubectl -n polyscope-test rollout status deployment/web --timeout=180s
  kubectl -n polyscope-test rollout status statefulset/db --timeout=180s
  kubectl -n polyscope-test rollout status daemonset/agent --timeout=180s
  kubectl -n polyscope-test wait --for=condition=complete job/migrate job/nightly-manual --timeout=180s
  kubectl -n polyscope-test wait --for=condition=Ready pod/counter --timeout=180s
  kubectl -n polyscope-files rollout status deployment/files-busybox --timeout=180s
  kubectl -n polyscope-files rollout status statefulset/files-coreutils --timeout=180s
  kubectl -n polyscope-files rollout status deployment/files-shellless --timeout=180s
  kubectl -n polyscope-files rollout status deployment/files-pair --timeout=180s
  kubectl -n polyscope-files rollout status deployment/files-rollout --timeout=180s
  # A context signed in as the seed's restricted ServiceAccount, for the permission errors; a session outlasts CI's 2 h.
  kubectl config set-credentials polyscope-restricted \
    --token="$(kubectl -n polyscope-test create token restricted --duration=24h)"
  kubectl config set-context kind-polyscope-restricted --cluster=kind-polyscope --user=polyscope-restricted
  put POLYSCOPE_TEST_KUBE_CONTEXT kind-polyscope
  put POLYSCOPE_TEST_KUBE_RESTRICTED_CONTEXT kind-polyscope-restricted
  put POLYSCOPE_TEST_KUBE_NAMESPACE polyscope-test
  put POLYSCOPE_TEST_KUBE_FILES_NAMESPACE polyscope-files
}

# Runs each step under set -e on its own, so one that fails is named in $dir/failed and the rest still start. Never
# call it as an if's condition: that turns set -e off in the step too.
failed=
step() {
  echo "== $1"
  ( set -e; "$1" )
  status=$?
  [ "$status" -eq 0 ] || { echo "== $1 failed ($status)"; failed="$failed $1"; }
}

# sshd wants its privilege separation folder; the tests' scripts would sudo for it, and a session is root already.
mkdir -p /run/sshd
# Fastest first, so the tests can use each backend as soon as it's up.
step dependencies
step ssh_files
step s3
step journal
step engine
case "$failed" in
  *engine*) failed="$failed azure docker_logs kubernetes" ;;
  *)
    step azure
    step docker_logs
    step kubernetes
    ;;
esac

[ -z "$failed" ] || echo "${failed# }" > "$dir/failed"
touch "$dir/done"
echo "== done${failed:+, these didn't start:$failed}"
rm -f "$dir/pid"
