import { describe, expect, it } from 'vitest'
import { missingPermission } from './rbac'

// The API server's own wording, from a namespaced request, a cluster-wide one and a non-resource one.
const forbidden = (what: string, rest: string) => `${what} is forbidden: User "system:serviceaccount:polyscope-test:restricted" cannot ${rest}`

describe('RBAC denials', () => {
  it('name the verb, resource and namespace of a namespaced request', () => {
    const message = forbidden('pods', 'list resource "pods" in API group "" in the namespace "shop"')

    expect(missingPermission(message)).toBe('list pods in namespace shop')
  })

  it('keep a subresource with its resource', () => {
    const message = forbidden('pods "counter"', 'get resource "pods/log" in API group "" in the namespace "shop"')

    expect(missingPermission(message)).toBe('get pods/log in namespace shop')
  })

  it('qualify a resource outside the core API group with its group, as kubectl does', () => {
    const list = forbidden('deployments.apps', 'list resource "deployments" in API group "apps" in the namespace "shop"')
    const scale = forbidden('deployments.apps "web"', 'patch resource "deployments/scale" in API group "apps" in the namespace "shop"')

    expect(missingPermission(list)).toBe('list deployments.apps in namespace shop')
    expect(missingPermission(scale)).toBe('patch deployments.apps/scale in namespace shop')
  })

  it('say a cluster-wide request is cluster-wide', () => {
    const message = forbidden('namespaces "shop"', 'get resource "namespaces" in API group "" at the cluster scope')

    expect(missingPermission(message)).toBe('get namespaces cluster-wide')
  })

  it('name the path of a request for no resource', () => {
    const message = 'forbidden: User "jane" cannot get path "/version"'

    expect(missingPermission(message)).toBe('get path /version')
  })

  it('ignore why the authorizer said no, after the denial itself', () => {
    const message = `${forbidden('pods', 'list resource "pods" in API group "" in the namespace "shop"')}: RBAC: role.rbac.authorization.k8s.io "reader" not found`

    expect(missingPermission(message)).toBe('list pods in namespace shop')
  })

  it('are not recognised in any other refusal', () => {
    expect(missingPermission('pods "counter" is forbidden: unable to create new content in namespace shop because it is being terminated')).toBeUndefined()
    expect(missingPermission('HTTP 403')).toBeUndefined()
    expect(missingPermission('')).toBeUndefined()
  })
})
