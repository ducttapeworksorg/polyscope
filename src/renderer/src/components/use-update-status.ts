import { useEffect, useState } from 'react'
import type { UpdateStatus } from '@shared/updates'

/** The app's update status, kept current as checks and downloads go on. */
export function useUpdateStatus(): UpdateStatus {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' })
  useEffect(() => {
    const unsubscribe = window.polyscope.onUpdateStatus(setStatus)
    void window.polyscope.getUpdateStatus().then(setStatus)
    return unsubscribe
  }, [])
  return status
}

/** The running app's version, once known. */
export function useAppVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null)
  useEffect(() => {
    void window.polyscope.appVersion().then(setVersion)
  }, [])
  return version
}
