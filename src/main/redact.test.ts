import { describe, expect, it } from 'vitest'
import { redact } from './redact'

describe('redact', () => {
  it('leaves ordinary log lines alone', () => {
    const line = '2026-09-28T10:00:00.000Z INFO connect failed for Source "prod logs": ECONNREFUSED 10.0.0.4:443'
    expect(redact(line)).toBe(line)
  })

  it('removes the password from credential-bearing URLs, keeping the host', () => {
    expect(redact('proxy http://alice:hunter2@proxy.corp:3128 refused')).toBe('proxy http://[redacted]@proxy.corp:3128 refused')
    expect(redact('using https://token@git.example.com/repo')).toBe('using https://[redacted]@git.example.com/repo')
    expect(redact('proxy http://alice:p@ss@proxy:3128/x@y')).toBe('proxy http://[redacted]@proxy:3128/x@y')
  })

  it('removes secret-bearing query parameters, such as presigned S3 URLs', () => {
    const url =
      'GET https://bucket.s3.amazonaws.com/a.log?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20260928&X-Amz-Signature=abc123&X-Amz-Security-Token=FwoG&partNumber=2'
    expect(redact(url)).toBe(
      'GET https://bucket.s3.amazonaws.com/a.log?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=[redacted]&X-Amz-Signature=[redacted]&X-Amz-Security-Token=[redacted]&partNumber=2'
    )
    expect(redact('/api/v1/watch?access_token=s3cr3t&limit=5')).toBe('/api/v1/watch?access_token=[redacted]&limit=5')
  })

  it('removes secrets written as key = value or key: value', () => {
    expect(redact('secretAccessKey=wJalrXUtnFEMI/K7MDENG')).toBe('secretAccessKey=[redacted]')
    expect(redact('password: hunter2 and more')).toBe('password: [redacted] and more')
    expect(redact('client_secret = abc')).toBe('client_secret = [redacted]')
    expect(redact('api-key=xyz')).toBe('api-key=[redacted]')
    expect(redact('passphrase=open sesame')).toBe('passphrase=[redacted] sesame')
  })

  it('removes key material from kubeconfig YAML quoted in an error', () => {
    const yaml = '  4 |     client-certificate-data: LS0tQ0VSVA==\n  5 |     client-key-data: LS0tLS1CRUdJTiBSU0Eg\n'
    expect(redact(yaml)).toBe('  4 |     client-certificate-data: LS0tQ0VSVA==\n  5 |     client-key-data: [redacted]\n')
  })

  it('removes secrets in JSON', () => {
    expect(redact('{"accessKeyId":"AKIA1","secretAccessKey":"wJalr/K7","name":"prod"}')).toBe(
      '{"accessKeyId":"[redacted]","secretAccessKey":"[redacted]","name":"prod"}'
    )
    expect(redact('{"sessionToken": "Fwo \\"quoted\\" GZ"}')).toBe('{"sessionToken": "[redacted]"}')
  })

  it('removes Authorization headers and bearer tokens', () => {
    expect(redact('Authorization: Bearer eyJabc.def')).toBe('Authorization: [redacted]')
    expect(redact('authorization=Basic dXNlcjpwYXNz')).toBe('authorization=[redacted]')
    expect(redact('sent bearer abc.DEF-123_x to the API')).toBe('sent bearer [redacted] to the API')
    expect(redact('{"Authorization":"Basic dXNlcjpwYXNz","Accept":"*/*"}')).toBe('{"Authorization":"[redacted]","Accept":"*/*"}')
  })

  it('removes cookies, all of them', () => {
    expect(redact('Cookie: session=abc; theme=dark')).toBe('Cookie: [redacted]')
    expect(redact('set-cookie=sid=1; Path=/')).toBe('set-cookie=[redacted]')
  })

  it('removes AWS access key IDs and JWTs wherever they appear', () => {
    expect(redact('The key AKIAIOSFODNN7EXAMPLE is not valid')).toBe('The key [redacted] is not valid')
    expect(redact('temporary ASIAY34FZKBOKMUTVV7A expired')).toBe('temporary [redacted] expired')
    expect(redact('token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl rejected')).toBe('token [redacted] rejected')
  })

  it('removes PEM private keys, keeping certificates', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\nabc\n-----END RSA PRIVATE KEY-----'
    expect(redact(`loaded ${key} ok`)).toBe('loaded [redacted private key] ok')
    const cert = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----'
    expect(redact(cert)).toBe(cert)
  })

  it('replaces the home directory with ~, so user names stay out of shared logs', () => {
    expect(redact('read C:\\Users\\alice\\logs\\a.log', { homeDir: 'C:\\Users\\alice' })).toBe('read ~\\logs\\a.log')
    expect(redact('read /home/alice/a.log and /home/alice', { homeDir: '/home/alice' })).toBe('read ~/a.log and ~')
    expect(redact('read /home/alicia/a.log', { homeDir: '/home/alice' })).toBe('read /home/alicia/a.log')
  })
})
