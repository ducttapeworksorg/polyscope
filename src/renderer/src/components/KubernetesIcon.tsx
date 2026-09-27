import type { ContainerRole, WorkloadKind } from '@shared/core-api'

// The Kubernetes community icons, and the container icons drawn to match them; as URLs to their own files like MaterialIcon's.
const urls = import.meta.glob<string>('../assets/kubernetes/*.svg', { eager: true, query: '?no-inline', import: 'default' })
const url = (name: string) => urls[`../assets/kubernetes/${name}.svg`]

const kindIcons: Record<WorkloadKind, string> = {
  Deployment: 'deploy',
  StatefulSet: 'sts',
  DaemonSet: 'ds',
  CronJob: 'cronjob',
  Job: 'job',
  Pod: 'pod'
}

/** For a Workload kind (or a pod), or a container with its role if it has one. */
type Props = { workloadKind: WorkloadKind } | { container: true; role?: ContainerRole }

/** A Workload kind's, pod's or container's icon, from the Kubernetes community icon set. */
export function KubernetesIcon(props: Props) {
  const name = 'workloadKind' in props ? kindIcons[props.workloadKind] : props.role ? `${props.role}-container` : 'container'
  return <img className="kubernetes-icon" src={url(name)} alt="" width={16} height={16} draggable={false} />
}
