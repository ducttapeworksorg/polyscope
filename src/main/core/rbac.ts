// Reading the API server's RBAC denials, so a user can tell their cluster admin what they're missing.

/** A resource as kubectl writes it: qualified with its API group unless it's in the core one, e.g. `deployments.apps/scale`. */
function qualified(resource: string, group: string) {
  if (!group) return resource
  const [name, ...subresource] = resource.split('/')
  return [`${name}.${group}`, ...subresource].join('/')
}

/**
 * What an API server's denial says is missing, e.g. `get pods/log in namespace shop` from its
 * `… cannot get resource "pods/log" in API group "" in the namespace "shop"`; undefined for any other refusal.
 */
export function missingPermission(message: string): string | undefined {
  const resource = /cannot (\S+) resource "([^"]+)" in API group "([^"]*)" (?:in the namespace "([^"]+)"|at the cluster scope)/.exec(message)
  if (resource) {
    const [, verb, name, group, namespace] = resource
    return `${verb} ${qualified(name!, group!)} ${namespace ? `in namespace ${namespace}` : 'cluster-wide'}`
  }
  const path = /cannot (\S+) path "([^"]+)"/.exec(message)
  if (path) return `${path[1]} path ${path[2]}`
  return undefined
}
