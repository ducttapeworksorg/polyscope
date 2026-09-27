import { execFile } from 'node:child_process'
import { basename, delimiter } from 'node:path'

// Marks where the PATH starts and ends in the shell's output, which rc files may add their own lines to.
const marker = '__POLYSCOPE_PATH__'

/** The PATH a login shell printed between markers, or null if it didn't. */
export function pathFromShellOutput(output: string): string | null {
  const start = output.indexOf(marker)
  const end = output.indexOf(marker, start + marker.length)
  return start < 0 || end < 0 ? null : output.slice(start + marker.length, end)
}

/** `preferred`'s entries, then those only in `current`, each once, keeping their order. */
export function mergePaths(preferred: string, current: string): string {
  return [...new Set([...preferred.split(delimiter), ...current.split(delimiter)].filter(Boolean))].join(delimiter)
}

/**
 * Apps launched from Finder or a desktop launcher don't get the PATH the user's shell sets up, so the
 * kubeconfig exec auth plugins (aws, gke-gcloud-auth-plugin, kubelogin…) it finds wouldn't be found.
 * This asks the user's login shell for its PATH and puts it ahead of the one the app started with.
 * Does nothing on Windows, where apps get the user's PATH anyway, or if the shell fails or takes too long.
 */
export async function loadLoginShellPath(): Promise<void> {
  if (process.platform === 'win32') return
  const shell = process.env['SHELL'] || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
  // fish keeps PATH as a list, which "$PATH" would join with spaces.
  const path = basename(shell) === 'fish' ? '(string join : $PATH)' : '"$PATH"'
  const output = await new Promise<string>((resolve) => {
    execFile(shell, ['-ilc', `printf '%s' '${marker}' ${path} '${marker}'`], { timeout: 5_000 }, (error, stdout) =>
      resolve(error ? '' : stdout)
    )
  })
  const loginPath = pathFromShellOutput(output)
  if (loginPath) process.env['PATH'] = mergePaths(loginPath, process.env['PATH'] ?? '')
}
