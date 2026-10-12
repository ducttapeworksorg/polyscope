#!/bin/sh
# Fronts the default context's Docker Engine with TLS on 127.0.0.1:2376, as `dockerd --tlsverify` serves its API: only to
# clients showing a certificate its CA issued. ghostunnel does it in a container, from the engine's socket; a Docker context,
# polyscope-test-tls, reaches it with the client's CA, certificate and key. Run it after seed.sh, then the tests with
# POLYSCOPE_TEST_DOCKER_TLS_CONTEXT=polyscope-test-tls. `tls.sh --down` removes the front, the context and the certificates.
set -eu

front=polyscope-tls
context=polyscope-test-tls
certs="${TMPDIR:-/tmp}/polyscope-docker-tls"
socket=/var/run/docker.sock

if [ "${1:-}" = --down ]; then
  docker rm -f "$front" > /dev/null 2>&1 || true
  docker context rm -f "$context" > /dev/null 2>&1 || true
  rm -rf "$certs"
  exit 0
fi

docker rm -f "$front" > /dev/null 2>&1 || true
docker context rm -f "$context" > /dev/null 2>&1 || true
rm -rf "$certs"
mkdir -p "$certs"
cd "$certs"

# A CA, a certificate it issued the engine for 127.0.0.1 and localhost, and one it issued a client: what
# Docker's "Protect the Docker daemon socket" guide makes.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=Polyscope Test Docker CA' -keyout ca-key.pem -out ca.pem 2> /dev/null
openssl req -newkey rsa:2048 -nodes -subj '/CN=localhost' -keyout server-key.pem -out server.csr 2> /dev/null
printf 'subjectAltName = DNS:localhost,IP:127.0.0.1\nextendedKeyUsage = serverAuth\n' > server.ext
openssl x509 -req -days 1 -in server.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -extfile server.ext -out server-cert.pem 2> /dev/null
openssl req -newkey rsa:2048 -nodes -subj '/CN=Polyscope Test Client' -keyout key.pem -out client.csr 2> /dev/null
printf 'extendedKeyUsage = clientAuth\n' > client.ext
openssl x509 -req -days 1 -in client.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -extfile client.ext -out cert.pem 2> /dev/null
chmod 644 ./*.pem

# ghostunnel, in Go as dockerd is, so it serves TLS as the engine would (socat can't take a resumed session).
docker run -d --name "$front" -p 127.0.0.1:2376:2376 -v "$socket:/var/run/docker.sock" -v "$certs:/certs:ro" \
  ghostunnel/ghostunnel:v1.11.3 server --listen 0.0.0.0:2376 --target unix:/var/run/docker.sock \
  --cert /certs/server-cert.pem --key /certs/server-key.pem --cacert /certs/ca.pem --allow-all > /dev/null

docker context create "$context" --description 'The test engine, fronted with TLS (tests/docker/tls.sh)' \
  --docker "host=tcp://127.0.0.1:2376,ca=$certs/ca.pem,cert=$certs/cert.pem,key=$certs/key.pem" > /dev/null

# Waits up to 30 s for the engine to answer through the front.
for _ in $(seq 1 30); do
  docker --context "$context" version > /dev/null 2>&1 && exit 0
  sleep 1
done
echo "The engine never answered through $context" >&2
exit 1
