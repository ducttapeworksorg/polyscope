// What the Kubernetes Source Types share: turning failed calls into CoreErrors, and finding a Workload's pods.

import { ApiException, AppsV1Api, BatchV1Api, CoreV1Api, type KubeConfig, type V1ObjectMeta, type V1Pod, type V1ReplicaSet } from '@kubernetes/client-node'
import type { WorkloadKind } from '@shared/core-api'
import { CoreError } from './core-error'
import { certificateCodes, networkCodes } from './network-errors'
import { missingPermission } from './rbac'

/** What owns an object: the owner reference marked as its controller. */
export const controllerOf = (meta: V1ObjectMeta | undefined) => meta?.ownerReferences?.find((owner) => owner.controller)

/** The error codes along an error and its causes, e.g. a failed fetch's ECONNREFUSED. */
function codesOf(error: unknown): string[] {
  const codes: string[] = []
  for (let cause = error; cause instanceof Error && codes.length < 10; cause = cause.cause) {
    const code = (cause as { code?: unknown }).code
    if (typeof code === 'string') codes.push(code)
  }
  return codes
}

/** The message the API server gave with a failed call, which ApiException buries in a longer one. */
export function serverMessage({ code, body }: { code: number; body: unknown }): string {
  let status: unknown = body
  if (typeof body === 'string') {
    try {
      status = JSON.parse(body)
    } catch {
      return body || `HTTP ${code}`
    }
  }
  const message = (status as { message?: unknown } | undefined)?.message
  return typeof message === 'string' ? message : `HTTP ${code}`
}

/** A failed Kubernetes call as a CoreError. */
export function asCoreError(error: unknown): CoreError {
  if (error instanceof CoreError) return error
  if (error instanceof ApiException) {
    const message = serverMessage(error)
    if (error.code === 401) return new CoreError('AUTH_FAILED', message)
    if (error.code === 403) {
      const missing = missingPermission(message)
      return missing ? new CoreError('MISSING_PERMISSION', missing) : new CoreError('PERMISSION_DENIED', message)
    }
    if (error.code === 404) return new CoreError('NOT_FOUND', message)
    return new CoreError('UNKNOWN', message)
  }
  const message = error instanceof Error ? error.message : String(error)
  const codes = codesOf(error)
  // An exec auth plugin (aws, gke-gcloud-auth-plugin, kubelogin…) that isn't on the PATH.
  const spawn = (error as { syscall?: unknown } | null)?.syscall
  if (codes.includes('ENOENT') && typeof spawn === 'string' && spawn.startsWith('spawn')) {
    return new CoreError('CREDENTIALS_UNAVAILABLE', `${spawn.slice('spawn '.length)} was not found: ${message}`)
  }
  if (codes.some((code) => networkCodes.has(code))) return new CoreError('UNREACHABLE', `${message} (${codes.join(', ')})`)
  if (codes.some((code) => certificateCodes.has(code))) return new CoreError('CERTIFICATE_UNTRUSTED', `${message} (${codes.join(', ')})`)
  return new CoreError('UNKNOWN', message)
}

/** Runs a Kubernetes call, turning its failure into a CoreError. */
export async function call<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request()
  } catch (error) {
    throw asCoreError(error)
  }
}

/** Fails with NAMESPACE_NOT_FOUND if the namespace isn't there; a user who may not read namespaces gets the benefit of the doubt. */
export async function checkNamespace(core: CoreV1Api, namespace: string) {
  try {
    await call(() => core.readNamespace({ name: namespace }))
  } catch (error) {
    const { code } = error as CoreError
    if (code === 'NOT_FOUND') throw new CoreError('NAMESPACE_NOT_FOUND', `No namespace named ${namespace}`)
    if (code !== 'MISSING_PERMISSION' && code !== 'PERMISSION_DENIED') throw error
  }
}

/** The Workload kinds whose pods are found through the Workload itself, rather than a CronJob's Jobs. */
export type PodOwnerKind = Exclude<WorkloadKind, 'Pod' | 'CronJob'>

export interface KubernetesApis {
  core: CoreV1Api
  apps: AppsV1Api
  batch: BatchV1Api
}

/** The API clients a Kubernetes Source uses, set up from its kubeconfig. */
export const apisFor = (config: KubeConfig): KubernetesApis => ({
  core: config.makeApiClient(CoreV1Api),
  apps: config.makeApiClient(AppsV1Api),
  batch: config.makeApiClient(BatchV1Api)
})

export const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** The names of listed objects, sorted. */
export const sortedNames = (items: { metadata?: { name?: string } }[]) =>
  items.flatMap((item) => (item.metadata?.name ? [item.metadata.name] : [])).sort(byName.compare)

/** The namespaces in the cluster, by name. */
export async function listNamespaces(config: KubeConfig): Promise<string[]> {
  return sortedNames((await call(() => apisFor(config).core.listNamespace())).items)
}

/** Reads a Workload; NOT_FOUND if the namespace has no such one. */
export function readWorkload({ apps, batch }: KubernetesApis, namespace: string, kind: PodOwnerKind, name: string) {
  const read: () => Promise<{ metadata?: V1ObjectMeta }> = {
    Deployment: () => apps.readNamespacedDeployment({ name, namespace }),
    StatefulSet: () => apps.readNamespacedStatefulSet({ name, namespace }),
    DaemonSet: () => apps.readNamespacedDaemonSet({ name, namespace }),
    Job: () => batch.readNamespacedJob({ name, namespace })
  }[kind]
  return call(read)
}

/** Of a namespace's `pods`, those the Workload of `kind` with `uid` owns: a Deployment through its `replicaSets`, the rest directly. */
export function podsOwnedBy(kind: PodOwnerKind, uid: string | undefined, pods: V1Pod[], replicaSets: V1ReplicaSet[] = []) {
  if (!uid) return []
  const owners = new Set(kind === 'Deployment' ? replicaSets.filter((rs) => controllerOf(rs.metadata)?.uid === uid).map((rs) => rs.metadata?.uid) : [uid])
  return pods.filter((pod) => owners.has(controllerOf(pod.metadata)?.uid))
}

/** The ReplicaSets of a namespace, through which its Deployments own their pods. */
export const listReplicaSets = async ({ apps }: KubernetesApis, namespace: string) =>
  (await call(() => apps.listNamespacedReplicaSet({ namespace }))).items

/** The pods of a Workload, going by who owns them; `pods` are the namespace's, if already listed. NOT_FOUND if there's no such Workload. */
export async function podsOfWorkload(apis: KubernetesApis, namespace: string, kind: PodOwnerKind, name: string, pods?: Promise<V1Pod[]>) {
  const listed = pods ?? call(() => apis.core.listNamespacedPod({ namespace })).then((list) => list.items)
  const [workload, all] = await Promise.all([readWorkload(apis, namespace, kind, name), listed])
  const replicaSets = kind === 'Deployment' ? await listReplicaSets(apis, namespace) : []
  return podsOwnedBy(kind, workload.metadata?.uid, all, replicaSets)
}
