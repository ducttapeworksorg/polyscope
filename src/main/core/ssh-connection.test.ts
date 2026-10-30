import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectSsh, maxPooledConnections, type SshConnection, type SshJump } from './ssh-connection'
import { startTestSshServer, type TestProcess, type TestServerOptions, type TestSshServer } from './ssh-test-server'

/** What a test started, to stop after it. */
const started: (TestSshServer | SshConnection)[] = []

afterEach(async () => {
  for (const thing of started.splice(0).reverse()) await thing.close()
})

/** A server whose `follow` runs until the client ends it, as `journalctl --follow` does. */
async function startServer(options: TestServerOptions = {}) {
  const running: TestProcess[] = []
  const server = await startTestSshServer({
    exec: (command) => (command === 'follow' ? { run: (process) => void running.push(process) } : undefined),
    ...options
  })
  started.push(server)
  return Object.assign(server, { running })
}

const targetOf = (server: TestSshServer, host = server.host) => ({ host, port: server.port, user: server.user, privateKey: server.clientKey })

async function connect(server: TestSshServer, jumps: SshJump[] = [], host?: string) {
  const connection = await connectSsh(targetOf(server, host), { checkHostKey: () => 'trusted' }, jumps)
  started.push(connection)
  return connection
}

/**
 * Starts `count` follows over `connection`, one after another, resolving with their channels once each is running.
 * Each is read, as its caller would, so it closes once it ends.
 */
async function follow(connection: SshConnection, count: number) {
  const channels = []
  for (let i = 0; i < count; i++) channels.push((await connection.exec('follow')).resume())
  return channels
}

/** Resolves once `channel` has closed. */
const closedOf = (channel: { once(event: 'close', listener: () => void): unknown }) => new Promise<void>((resolve) => channel.once('close', () => resolve()))

describe('an SSH connection to a server that limits sessions on one connection (MaxSessions)', () => {
  it('runs more commands at once than one connection allows, over more connections to the server', async () => {
    const server = await startServer({ maxSessions: 2 })
    const connection = await connect(server)

    await follow(connection, 5)

    expect(server.running).toHaveLength(5)
    expect(server.connectionCount()).toBe(3)
  })

  it('opens no more connections than the commands started at once need', async () => {
    const server = await startServer({ maxSessions: 2 })
    const connection = await connect(server)

    await Promise.all(Array.from({ length: 5 }, async () => (await connection.exec('follow')).resume()))

    expect(server.running).toHaveLength(5)
    expect(server.connectionCount()).toBe(3)
  })

  it('closes an extra connection once nothing runs on it, keeping the first open', async () => {
    const server = await startServer({ maxSessions: 2 })
    const connection = await connect(server)
    const channels = await follow(connection, 3)

    const closed = Promise.all(channels.map(closedOf))
    for (const process of server.running) process.exit(0)
    await closed

    await vi.waitFor(() => expect(server.connectionCount()).toBe(1))
    expect(connection.closed).toBe(false)
    await follow(connection, 1)
    expect(server.connectionCount()).toBe(1)
  })

  it('runs a command on a full connection again once one of its own commands ends', async () => {
    const server = await startServer({ maxSessions: 2 })
    const connection = await connect(server)
    const [onFirst] = await follow(connection, 3)

    const closed = closedOf(onFirst!)
    server.running[0]!.exit(0)
    await closed
    await follow(connection, 1)

    expect(server.connectionCount()).toBe(2)
  })

  it('ends only the commands on an extra connection that drops, without the connection dropping', async () => {
    const server = await startServer({ maxSessions: 2 })
    const connection = await connect(server)
    const dropped = vi.fn()
    connection.onDrop(dropped)
    const channels = await follow(connection, 3)
    const ended: number[] = []
    channels.forEach((channel, index) => channel.once('close', () => ended.push(index)))

    await server.dropConnection(1)

    await vi.waitFor(() => expect(ended).toEqual([2]))
    expect(dropped).not.toHaveBeenCalled()
    expect(connection.closed).toBe(false)
    await follow(connection, 1)
    expect(server.running).toHaveLength(4)
  })

  it('ends everything, on every connection, when the first drops', async () => {
    const server = await startServer({ maxSessions: 2 })
    const connection = await connect(server)
    const dropped = vi.fn()
    connection.onDrop(dropped)
    const channels = await follow(connection, 3)

    const closed = Promise.all(channels.map(closedOf))
    await server.dropConnection(0)
    await closed

    expect(dropped).toHaveBeenCalledOnce()
    expect(connection.closed).toBe(true)
    await vi.waitFor(() => expect(server.connectionCount()).toBe(0))
    await expect(connection.exec('follow')).rejects.toMatchObject({ code: 'UNREACHABLE', message: /the connection closed/ })
  })

  it('closes every connection when closed', async () => {
    const server = await startServer({ maxSessions: 1 })
    const connection = await connect(server)
    await follow(connection, 3)

    connection.close()

    await vi.waitFor(() => expect(server.connectionCount()).toBe(0))
  })

  it('reaches a server behind a bastion over more channels the bastion forwards, not by signing in to it again', async () => {
    const bastion = await startServer()
    const server = await startServer({ maxSessions: 1 })
    const jumps = [{ target: targetOf(bastion), options: { checkHostKey: () => 'trusted' as const } }]
    const connection = await connect(server, jumps, 'logs.invalid')

    const [, onExtra] = await follow(connection, 2)

    expect(server.connectionCount()).toBe(2)
    expect(bastion.connectionCount()).toBe(1)
    expect(bastion.forwarded()).toEqual([`logs.invalid:${server.port}`, `logs.invalid:${server.port}`])

    const closed = closedOf(onExtra!)
    server.running[1]!.exit(0)
    await closed
    await vi.waitFor(() => expect(server.connectionCount()).toBe(1))
    expect(bastion.connectionCount()).toBe(1)
    await follow(connection, 1)
  })

  it('fails saying the server runs no commands if it refuses the first on a connection, without opening more', async () => {
    const server = await startServer({ maxSessions: 0 })
    const connection = await connect(server)

    await expect(connection.exec('follow')).rejects.toMatchObject({
      code: 'UNREACHABLE',
      message: expect.stringMatching(new RegExp(`won't run commands for ${server.user}`))
    })
    expect(server.connectionCount()).toBe(1)
  })

  it('fails naming MaxSessions, and why, when another connection can’t be opened', async () => {
    const server = await startServer({ maxSessions: 2, maxConnections: 1 })
    const connection = await connect(server)
    await follow(connection, 2)

    await expect(connection.exec('follow')).rejects.toMatchObject({
      code: 'UNREACHABLE',
      message: expect.stringMatching(/won't run more than 2 commands at once on one connection \(its MaxSessions\), and another connection failed: .+/)
    })
    expect(connection.closed).toBe(false)
  })

  it('opens no more than a backstop of connections to a server, however few commands each runs', async () => {
    const server = await startServer({ maxSessions: 1 })
    const connection = await connect(server)
    await follow(connection, maxPooledConnections)

    await expect(connection.exec('follow')).rejects.toMatchObject({
      code: 'UNREACHABLE',
      message: expect.stringMatching(new RegExp(`no more than ${maxPooledConnections} connections`))
    })
    expect(server.connectionCount()).toBe(maxPooledConnections)
  })
})
