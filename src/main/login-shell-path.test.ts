import { delimiter } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mergePaths, pathFromShellOutput } from './login-shell-path'

const path = (...entries: string[]) => entries.join(delimiter)

describe('the PATH from a login shell', () => {
  it('is what the shell printed between the markers, whatever its rc files printed around it', () => {
    const output = 'Welcome back!\n__POLYSCOPE_PATH__/opt/homebrew/bin:/usr/bin__POLYSCOPE_PATH__\nbye'

    expect(pathFromShellOutput(output)).toBe('/opt/homebrew/bin:/usr/bin')
  })

  it('is missing when the shell printed no markers', () => {
    expect(pathFromShellOutput('')).toBeNull()
    expect(pathFromShellOutput('__POLYSCOPE_PATH__/usr/bin')).toBeNull()
  })

  it('goes ahead of the PATH the app started with, which keeps the entries only it has', () => {
    expect(mergePaths(path('/opt/homebrew/bin', '/usr/bin'), path('/usr/bin', '/bin'))).toBe(path('/opt/homebrew/bin', '/usr/bin', '/bin'))
  })

  it('drops empty entries', () => {
    expect(mergePaths(path('', '/usr/bin', ''), '')).toBe('/usr/bin')
  })
})
