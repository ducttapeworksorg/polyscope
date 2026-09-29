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
