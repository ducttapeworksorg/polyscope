import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readSshConfig } from './ssh-config'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'polyscope-ssh-config-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

/** Writes a file under ~/.ssh, its lines joined. */
async function sshFile(name: string, ...lines: string[]) {
  const file = join(home, '.ssh', name)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, lines.join('\n'))
}

const config = (...lines: string[]) => sshFile('config', ...lines)

describe('an SSH config alias', () => {
  it('resolves to its HostName, User, Port and IdentityFile', async () => {
    await config('Host web', '  HostName web-1.example.com', '  User deploy', '  Port 2222', '  IdentityFile ~/.ssh/web_key')

    expect((await readSshConfig()).resolve('web')).toEqual({
      hostName: 'web-1.example.com',
      user: 'deploy',
      port: 2222,
      identityFiles: [join(home, '.ssh', 'web_key')],
      proxyJump: []
    })
  })

  it('takes each option from the first Host that matches and gives it, wildcards and negations as OpenSSH reads them', async () => {
    await config(
      '# Production',
      'Host *.prod !bastion.prod',
      '  User deploy',
      'Host web?.prod',
      '  User someone-else',
      '  Port 2222',
      'Host *',
      '  Port 22',
      '  User everyone',
      '  IdentityFile ~/.ssh/id_ed25519'
    )
    const ssh = await readSshConfig()

    expect(ssh.resolve('web1.prod')).toMatchObject({ hostName: 'web1.prod', user: 'deploy', port: 2222 })
    expect(ssh.resolve('web10.prod')).toMatchObject({ user: 'deploy', port: 22 })
    expect(ssh.resolve('bastion.prod')).toMatchObject({ user: 'everyone', port: 22 })
  })

  it('takes several IdentityFiles in order, and expands their tokens', async () => {
    await config('Host db', '  HostName db.internal', '  User pg', '  IdentityFile ~/.ssh/%r@%h', 'Host *', '  IdentityFile "%d/.ssh/my key"')

    expect((await readSshConfig()).resolve('db').identityFiles).toEqual([join(home, '.ssh', 'pg@db.internal'), join(home, '.ssh', 'my key')])
  })

  it('reads Keyword=value lines, and keywords in any case', async () => {
    await config('HOST=box', 'hostname = box.internal', 'USER=root')

    expect((await readSshConfig()).resolve('box')).toMatchObject({ hostName: 'box.internal', user: 'root' })
  })

  it('ignores a comment at the end of a line, and a Port that isn’t a number', async () => {
    await config('Host web # production', '  User deploy # the app user', '  Port twenty-two', 'Host *', '  Port 2222')

    const ssh = await readSshConfig()
    expect(ssh.resolve('web')).toMatchObject({ user: 'deploy', port: 2222 })
    expect(ssh.hosts()).toEqual(['web'])
  })

  it('leaves a host the config doesn’t mention as it is, as when there’s no config', async () => {
    expect((await readSshConfig()).resolve('logs.internal')).toEqual({ hostName: 'logs.internal', identityFiles: [], proxyJump: [] })
    await config('Host other', '  User x')

    expect((await readSshConfig()).resolve('logs.internal')).toEqual({ hostName: 'logs.internal', identityFiles: [], proxyJump: [] })
  })

  it('expands %h in HostName to the host given', async () => {
    await config('Host *.lab', '  HostName %h.example.com')

    expect((await readSshConfig()).resolve('pi.lab').hostName).toBe('pi.lab.example.com')
  })
})

describe('Include', () => {
  it('reads the files it names in place, relative to ~/.ssh, wildcards in lexical order', async () => {
    await config('Include config.d/*', 'Host *', '  User fallback')
    await sshFile('config.d/20-web', 'Host web', '  User second')
    await sshFile('config.d/10-web', 'Host web', '  HostName web.internal', '  User first')

    expect((await readSshConfig()).resolve('web')).toMatchObject({ hostName: 'web.internal', user: 'first' })
  })

  it('under a Host applies only to that Host, and an absolute or ~ path is read as it is', async () => {
    await sshFile('elsewhere/db', '  User from-include')
    await config('Host db', `  Include ~/.ssh/elsewhere/db`, 'Host other', `  Include ${join(home, '.ssh', 'elsewhere', 'db')}`, 'Host *', '  User fallback')

    const ssh = await readSshConfig()
    expect(ssh.resolve('db').user).toBe('from-include')
    expect(ssh.resolve('other').user).toBe('from-include')
    expect(ssh.resolve('web').user).toBe('fallback')
  })

  it('under a Host that doesn’t match, applies none of the file, even its own Host lines', async () => {
    await sshFile('everyone', 'Host *', '  User from-include')
    await config('Host other', '  Include everyone', 'Host *', '  User fallback')

    const ssh = await readSshConfig()
    expect(ssh.resolve('web').user).toBe('fallback')
    expect(ssh.resolve('other').user).toBe('from-include')
  })

  it('skips a file that isn’t there, and stops at an Include loop', async () => {
    await config('Include missing', 'Include config', 'Host web', '  User deploy')

    expect((await readSshConfig()).resolve('web').user).toBe('deploy')
  })
})

describe('ProxyJump', () => {
  it('lists the bastions to go through, in order', async () => {
    await config('Host inner', '  ProxyJump bastion,ops@second:2222', 'Host *', '  ProxyJump ignored')

    expect((await readSshConfig()).resolve('inner').proxyJump).toEqual(['bastion', 'ops@second:2222'])
  })

  it('is none when the first to give it says none, or ProxyCommand comes first', async () => {
    await config('Host direct', '  ProxyJump none', 'Host piped', '  ProxyCommand nc %h %p', 'Host *', '  ProxyJump bastion')

    const ssh = await readSshConfig()
    expect(ssh.resolve('direct').proxyJump).toEqual([])
    expect(ssh.resolve('piped')).toMatchObject({ proxyJump: [], proxyCommand: 'nc %h %p' })
  })

  it('stands in the way of a later ProxyCommand, and ProxyCommand none is no ProxyCommand', async () => {
    await config('Host jumped', '  ProxyJump bastion', 'Host plain', '  ProxyCommand none', 'Host *', '  ProxyCommand nc %h %p')

    const ssh = await readSshConfig()
    expect(ssh.resolve('jumped')).toEqual(expect.not.objectContaining({ proxyCommand: expect.anything() }))
    expect(ssh.resolve('plain')).toEqual(expect.not.objectContaining({ proxyCommand: expect.anything() }))
  })
})

describe('the aliases suggested', () => {
  it('are the Host names without wildcards or negations, in Included files too, each once', async () => {
    await config('Host web db', 'Host *.prod !bastion.prod', 'Include extra', 'Host web', 'Match all', 'Host *')
    await sshFile('extra', 'Host build-?? cache')

    expect((await readSshConfig()).hosts()).toEqual(['web', 'db', 'cache'])
  })
})
