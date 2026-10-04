/**
 * Where the app is in finding and applying a newer release from GitHub Releases.
 *
 * - `off`: this build doesn't update itself (a development build, run from source).
 * - `available`: a newer release that this install can't apply itself; updating opens its download page.
 * - `downloading` then `ready`: a newer release this install applies itself; updating restarts into it. If
 *   installing it failed instead, `installFailed` says why, and it can be tried again.
 */
export type UpdateStatus =
  | { state: 'off' }
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'upToDate' }
  | { state: 'available'; version: string }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'ready'; version: string; installFailed?: string }
  | { state: 'error'; message: string }

/** Whether there's an update to act on: a download page to open, or a restart into one downloaded. */
export const canApply = (status: UpdateStatus): status is Extract<UpdateStatus, { state: 'available' | 'ready' }> =>
  status.state === 'available' || status.state === 'ready'
