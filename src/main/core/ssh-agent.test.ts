import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ParsedKey } from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'
import { findSshAgent } from './ssh-agent'
import { generateKey, startTestSshAgent, type TestSshAgent } from './ssh-test-server'

const agents: TestSshAgent[] = []

afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()))
})

/** Starts an agent holding a key of its own, returning where it listens and its key, to tell it from another. */
const startAgent = async () => {
  const key = generateKey()
  const agent = await startTestSshAgent(key.private)
  agents.push(agent)
  return { path: agent.path, keys: [key.public.split(' ')[1]] }
}

/** Somewhere no agent listens, as SSH_AUTH_SOCK or a pipe would name it. */
const nowhere = process.platform === 'win32' ? '\\\\.\\pipe\\polyscope-no-agent' : join(tmpdir(), 'polyscope-no-agent.sock')

/** The keys an agent holds, to tell which agent was found. */
const keysOf = async (agent: Awaited<ReturnType<typeof findSshAgent>>) =>
  new Promise<string[]>((resolve, reject) =>
    agent.getIdentities((error, keys) => (error ? reject(error) : resolve((keys ?? []).map((k) => (k as ParsedKey).getPublicSSH().toString('base64')))))
  )

describe('finding the SSH agent', () => {
  it('uses the one at SSH_AUTH_SOCK', async () => {
    const agent = await startAgent()
    const other = await startAgent()

    expect(await keysOf(await findSshAgent({ env: { SSH_AUTH_SOCK: agent.path }, platform: 'linux', openSshPipe: other.path }))).toEqual(agent.keys)
    expect(await keysOf(await findSshAgent({ env: { SSH_AUTH_SOCK: agent.path }, platform: 'win32', openSshPipe: other.path }))).toEqual(agent.keys)
  })

  it('fails saying so outside Windows when SSH_AUTH_SOCK isn’t set, or nothing answers there', async () => {
    await expect(findSshAgent({ env: {}, platform: 'linux' })).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND', message: /SSH_AUTH_SOCK isn’t set/ })
    await expect(findSshAgent({ env: { SSH_AUTH_SOCK: nowhere }, platform: 'darwin' })).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' })
  })

  it('on Windows, goes on to the OpenSSH agent when SSH_AUTH_SOCK isn’t set or nothing answers there', async () => {
    const openSsh = await startAgent()

    expect(await keysOf(await findSshAgent({ env: {}, platform: 'win32', openSshPipe: openSsh.path }))).toEqual(openSsh.keys)
    expect(await keysOf(await findSshAgent({ env: { SSH_AUTH_SOCK: nowhere }, platform: 'win32', openSshPipe: openSsh.path }))).toEqual(openSsh.keys)
  })

  it('on Windows, fails naming each agent looked for when none answers', async () => {
    await expect(findSshAgent({ env: { SSH_AUTH_SOCK: nowhere }, platform: 'win32', openSshPipe: nowhere })).rejects.toMatchObject({
      code: 'AGENT_NOT_FOUND',
      message: expect.stringMatching(/SSH_AUTH_SOCK .*the OpenSSH Authentication Agent/)
    })
  })
})
