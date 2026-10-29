# Proxy environment variables are read as kubectl reads them, by every Source Type

When a Source has no Proxy of its own, every Source Type reads the proxy environment variables the way kubectl (Go's `net/http`) does. The uppercase spelling comes before the lowercase (`HTTPS_PROXY`, then `https_proxy`; `HTTP_PROXY`, then `http_proxy`; `NO_PROXY`, then `no_proxy`), and a blank value counts as unset. `NO_PROXY` matches `*`, a domain and its subdomains, `.corp` / `*.corp` for subdomains only, an address or CIDR range, and any of them with a `:port`. Loopback is never proxied. `ALL_PROXY` / `all_proxy` is ignored. Polyscope works out the proxy for each request's host itself (`proxyFromEnv`), rather than handing the environment to Node's agents (`proxyEnv`), which read the lowercase names first, ignore CIDR entries and proxy loopback. A machine that sets both spellings differently would otherwise send one Source Type through one proxy and another Source Type through another (#99). kubectl's rules win because Kubernetes users compare Polyscope with kubectl directly.

## Consequences

S3-compatible Storage, Azure Blob Storage and CloudWatch Logs requests go out through agents that choose for each request, as the environment is when it's made, between a direct agent and one for the proxy it names. A plain http request through a proxy is rewritten to ask for its full URL, as Node does for an agent with a proxy of its own. A Source's own Proxy still takes every request, with no `NO_PROXY` and no loopback exemption, as kubeconfig's `proxy-url` does.

Azure's own token requests, behind signing in through Azure CLI auth, don't go through these agents yet: they still follow the Azure SDK's proxy policy, which reads `ALL_PROXY` and ignores the Source's Proxy and CA bundle (#105).
