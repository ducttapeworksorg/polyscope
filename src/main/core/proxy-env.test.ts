import { describe, expect, it } from 'vitest'
import { proxyFromEnv } from './proxy-env'

const proxy = 'http://proxy.corp:3128'

describe('the proxy the environment gives a cluster', () => {
  it('is HTTPS_PROXY for an https server, HTTP_PROXY for an http one', () => {
    const env = { HTTPS_PROXY: proxy, HTTP_PROXY: 'http://plain.corp:8080' }

    expect(proxyFromEnv('https://kube.corp:6443', env)).toBe(proxy)
    expect(proxyFromEnv('http://kube.corp:8080', env)).toBe('http://plain.corp:8080')
    expect(proxyFromEnv('https://kube.corp', { HTTP_PROXY: proxy })).toBeUndefined()
  })

  it('takes the lowercase names too, the uppercase ones first', () => {
    expect(proxyFromEnv('https://kube.corp', { https_proxy: proxy })).toBe(proxy)
    expect(proxyFromEnv('https://kube.corp', { HTTPS_PROXY: proxy, https_proxy: 'http://other:1' })).toBe(proxy)
  })

  it('is http when it names no scheme', () => {
    expect(proxyFromEnv('https://kube.corp', { HTTPS_PROXY: 'proxy.corp:3128' })).toBe(proxy)
    expect(proxyFromEnv('https://kube.corp', { HTTPS_PROXY: 'socks5://proxy.corp:1080' })).toBe('socks5://proxy.corp:1080')
  })

  it('is none when unset or blank', () => {
    expect(proxyFromEnv('https://kube.corp', {})).toBeUndefined()
    expect(proxyFromEnv('https://kube.corp', { HTTPS_PROXY: ' ' })).toBeUndefined()
  })

  it('is none for this machine, as with kubectl', () => {
    const env = { HTTPS_PROXY: proxy }

    for (const server of ['https://localhost:6443', 'https://127.0.0.1:6443', 'https://127.1.2.3', 'https://[::1]:6443']) {
      expect(proxyFromEnv(server, env)).toBeUndefined()
    }
  })

  describe('NO_PROXY', () => {
    const skipped = (server: string, noProxy: string) => proxyFromEnv(server, { HTTPS_PROXY: proxy, NO_PROXY: noProxy }) === undefined

    it('skips it for every host with *', () => {
      expect(skipped('https://kube.corp', '*')).toBe(true)
    })

    it('skips it for a domain and its subdomains', () => {
      expect(skipped('https://corp', 'corp')).toBe(true)
      expect(skipped('https://kube.corp', 'corp')).toBe(true)
      expect(skipped('https://kube.corp', 'other.corp, kube.corp')).toBe(true)
      expect(skipped('https://kubecorp', 'corp')).toBe(false)
    })

    it('skips it for only the subdomains of a domain starting with a dot, or *.', () => {
      expect(skipped('https://kube.corp', '.corp')).toBe(true)
      expect(skipped('https://corp', '.corp')).toBe(false)
      expect(skipped('https://kube.corp', '*.corp')).toBe(true)
      expect(skipped('https://corp', '*.corp')).toBe(false)
    })

    it('matches whatever the case', () => {
      expect(skipped('https://KUBE.Corp', 'kube.CORP')).toBe(true)
    })

    it('skips it for an address, or one in a CIDR range', () => {
      expect(skipped('https://10.0.0.5:6443', '10.0.0.5')).toBe(true)
      expect(skipped('https://10.0.0.5:6443', '10.0.0.0/8')).toBe(true)
      expect(skipped('https://10.0.0.5:6443', '192.168.0.0/16')).toBe(false)
      expect(skipped('https://[fd00::5]:6443', 'fd00::/8')).toBe(true)
    })

    it('matches the port when it names one, the scheme’s own when the server names none', () => {
      expect(skipped('https://kube.corp:6443', 'kube.corp:6443')).toBe(true)
      expect(skipped('https://kube.corp:6443', 'kube.corp:443')).toBe(false)
      expect(skipped('https://kube.corp', 'kube.corp:443')).toBe(true)
    })

    it('takes the lowercase name too', () => {
      expect(proxyFromEnv('https://kube.corp', { HTTPS_PROXY: proxy, no_proxy: 'corp' })).toBeUndefined()
    })
  })
})
