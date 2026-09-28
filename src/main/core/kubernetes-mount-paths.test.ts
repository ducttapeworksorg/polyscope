import { describe, expect, it } from 'vitest'
import { mountPathsOf } from './kubernetes-file-source'

describe('where a Workload’s volumes are mounted', () => {
  it('gathers the mounts of its sidecars and main containers, sorted, each once', () => {
    const template = {
      spec: {
        initContainers: [
          { name: 'proxy', restartPolicy: 'Always', volumeMounts: [{ name: 'logs', mountPath: '/var/log/proxy' }] }
        ],
        containers: [
          {
            name: 'app',
            volumeMounts: [
              { name: 'data', mountPath: '/data' },
              { name: 'logs', mountPath: '/var/log/app' }
            ]
          },
          { name: 'worker', volumeMounts: [{ name: 'data', mountPath: '/data' }] }
        ]
      }
    }

    expect(mountPathsOf(template)).toEqual(['/data', '/var/log/app', '/var/log/proxy'])
  })

  it('leaves out init containers that have finished by the time there’s anything to browse', () => {
    const template = {
      spec: {
        initContainers: [{ name: 'seed', volumeMounts: [{ name: 'data', mountPath: '/seed' }] }],
        containers: [{ name: 'app' }]
      }
    }

    expect(mountPathsOf(template)).toEqual([])
  })

  it('has none without a pod spec', () => {
    expect(mountPathsOf({})).toEqual([])
  })
})
