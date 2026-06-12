/**
 * Unit tests for the secret-placeholder substitution core (pure functions +
 * hot cache). The DB-backed retroactive redaction and the tool-executor
 * wiring are covered in secret-placeholders.integration.test.ts.
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import {
  extractPlaceholderKeys,
  substitutePlaceholders,
  resolvePlaceholderSecrets,
  rewritePlaceholdersToEnvRefs,
  buildSecretEnv,
  toEnvName,
  redactKnownSecrets,
  redactSecretsInResult,
  invalidateHotSecrets,
  noteHotSecret,
  mapJsonStrings,
  hostMatchesAllowlist,
  placeholderFor,
  hotSecretCount,
  MIN_REDACTABLE_SECRET_LENGTH,
} from '@/server/services/secret-substitution'

beforeEach(() => invalidateHotSecrets())

describe('extractPlaceholderKeys', () => {
  it('finds keys in nested objects, arrays, and JSON-stringified leaves', () => {
    const args = {
      url: 'https://api.github.com',
      headers: { Authorization: 'Bearer {{secret:GITHUB_TOKEN}}' },
      body: JSON.stringify({ token: '{{secret:OTHER_KEY}}' }),
      list: ['{{secret:GITHUB_TOKEN}}', 42, null],
    }
    expect(extractPlaceholderKeys(args).sort()).toEqual(['GITHUB_TOKEN', 'OTHER_KEY'])
  })

  it('returns empty for args without placeholders and ignores invalid keys', () => {
    expect(extractPlaceholderKeys({ a: 'no secrets here' })).toEqual([])
    // lowercase / leading digit are not valid vault keys — not placeholders
    expect(extractPlaceholderKeys({ a: '{{secret:lower}} {{secret:1BAD}}' })).toEqual([])
  })
})

describe('substitutePlaceholders', () => {
  it('replaces deeply and never mutates the original args', () => {
    const args = { headers: { auth: 'Bearer {{secret:TOK}}' }, n: 1 }
    const out = substitutePlaceholders(args, new Map([['TOK', 'real-value-123']])) as typeof args
    expect(out.headers.auth).toBe('Bearer real-value-123')
    expect(args.headers.auth).toBe('Bearer {{secret:TOK}}') // original untouched
    expect(out.n).toBe(1)
  })

  it('replaces multiple occurrences and multiple keys in one string', () => {
    const out = substitutePlaceholders(
      'a={{secret:A}} b={{secret:B}} a2={{secret:A}}',
      new Map([['A', 'aaaaaa'], ['B', 'bbbbbb']]),
    )
    expect(out).toBe('a=aaaaaa b=bbbbbb a2=aaaaaa')
  })

  it('leaves unresolved keys verbatim (caller fails closed before)', () => {
    const out = substitutePlaceholders('x={{secret:MISSING}}', new Map())
    expect(out).toBe('x={{secret:MISSING}}')
  })

  it('applies |base64 and |urlencode transforms', () => {
    const resolved = new Map([['CREDS', 'user:pass word']])
    const out = substitutePlaceholders(
      { auth: 'Basic {{secret:CREDS|base64}}', url: 'https://x?t={{secret:CREDS|urlencode}}', raw: '{{secret:CREDS}}' },
      resolved,
    ) as { auth: string; url: string; raw: string }
    expect(out.auth).toBe(`Basic ${Buffer.from('user:pass word').toString('base64')}`)
    expect(out.url).toBe(`https://x?t=${encodeURIComponent('user:pass word')}`)
    expect(out.raw).toBe('user:pass word')
  })

  it('redacts leaked TRANSFORMED values back to their transformed placeholder', () => {
    const b64 = Buffer.from('user:pass word').toString('base64')
    substitutePlaceholders({ a: '{{secret:CREDS|base64}}' }, new Map([['CREDS', 'user:pass word']]))
    expect(redactKnownSecrets(`leaked: ${b64}`)).toBe('leaked: {{secret:CREDS|base64}}')
  })

  it('is single-pass: a secret value containing a placeholder motif is not re-expanded', () => {
    const out = substitutePlaceholders(
      'v={{secret:EVIL}}',
      new Map([['EVIL', 'prefix {{secret:GITHUB_TOKEN}} suffix'], ['GITHUB_TOKEN', 'real']]),
    )
    expect(out).toBe('v=prefix {{secret:GITHUB_TOKEN}} suffix')
  })
})

describe('env-ref rewrite (secretsViaEnv tools)', () => {
  it('rewrites placeholders to ${HIVEKEEP_SECRET_*} references, never the value', () => {
    const out = rewritePlaceholdersToEnvRefs({
      command: 'GITHUB_TOKEN={{secret:GITHUB_TOKEN}} bun run x.ts && echo "{{secret:OTHER}}" "{{secret:OTHER|base64}}"',
    }) as { command: string }
    expect(out.command).toBe(
      'GITHUB_TOKEN=${HIVEKEEP_SECRET_GITHUB_TOKEN} bun run x.ts && echo "${HIVEKEEP_SECRET_OTHER}" "${HIVEKEEP_SECRET_OTHER_BASE64}"',
    )
  })

  it('builds the secretEnv map with prefixed names, one var per (key, transform)', () => {
    const args = { command: 'a={{secret:GH}} b={{secret:GH|base64}}' }
    expect(buildSecretEnv(args, new Map([['GH', 'value-123456']]))).toEqual({
      HIVEKEEP_SECRET_GH: 'value-123456',
      HIVEKEEP_SECRET_GH_BASE64: Buffer.from('value-123456').toString('base64'),
    })
    expect(toEnvName('A_B')).toBe('HIVEKEEP_SECRET_A_B')
    expect(toEnvName('A_B', 'urlencode')).toBe('HIVEKEEP_SECRET_A_B_URLENC')
  })
})

describe('resolvePlaceholderSecrets', () => {
  it('reports missing keys and feeds the hot cache with resolved ones', async () => {
    const getter = async (key: string) => (key === 'KNOWN' ? 'known-value-123' : null)
    const { resolved, missing } = await resolvePlaceholderSecrets(['KNOWN', 'NOPE'], getter)
    expect(resolved.get('KNOWN')).toBe('known-value-123')
    expect(missing).toEqual(['NOPE'])
    expect(redactKnownSecrets('x known-value-123 y')).toBe(`x ${placeholderFor('KNOWN')} y`)
  })
})

describe('output redaction', () => {
  it('replaces hot values in nested results, including error fields', () => {
    noteHotSecret('TOK', 'sk-live-abcdef123456')
    const result = {
      output: 'token is sk-live-abcdef123456\nsecond line sk-live-abcdef123456',
      error: 'fetch https://x?key=sk-live-abcdef123456 failed',
      nested: [{ v: 'sk-live-abcdef123456' }],
    }
    const red = redactSecretsInResult(result) as typeof result
    const ph = placeholderFor('TOK')
    expect(red.output).toBe(`token is ${ph}\nsecond line ${ph}`)
    expect(red.error).toBe(`fetch https://x?key=${ph} failed`)
    expect(red.nested[0]!.v).toBe(ph)
    // original untouched
    expect(result.output).toContain('sk-live-abcdef123456')
  })

  it('is literal — regex special chars in the value do not break it', () => {
    noteHotSecret('RX', 'p$ss^w(rd).*+?')
    expect(redactKnownSecrets('x p$ss^w(rd).*+? y')).toBe(`x ${placeholderFor('RX')} y`)
  })

  it(`never caches values shorter than ${MIN_REDACTABLE_SECRET_LENGTH} chars`, () => {
    noteHotSecret('TINY', 'yes')
    expect(hotSecretCount()).toBe(0)
    expect(redactKnownSecrets('yes we can')).toBe('yes we can')
  })

  it('is a no-op passthrough when the cache is empty', () => {
    const result = { a: 'whatever' }
    expect(redactSecretsInResult(result)).toBe(result)
  })

  it('honours invalidation (per key and full clear)', () => {
    noteHotSecret('A', 'value-aaaaaa')
    noteHotSecret('B', 'value-bbbbbb')
    invalidateHotSecrets('A')
    expect(redactKnownSecrets('value-aaaaaa value-bbbbbb')).toBe(`value-aaaaaa ${placeholderFor('B')}`)
    invalidateHotSecrets()
    expect(hotSecretCount()).toBe(0)
  })
})

describe('hostMatchesAllowlist', () => {
  it('matches exact hostnames case-insensitively, ignoring port and path', () => {
    expect(hostMatchesAllowlist('https://API.GitHub.com:8443/repos?x=1', ['api.github.com'])).toBe(true)
    expect(hostMatchesAllowlist('https://github.com', ['api.github.com'])).toBe(false)
  })

  it('matches *.wildcards on subdomains only, never the apex', () => {
    expect(hostMatchesAllowlist('https://api.github.com', ['*.github.com'])).toBe(true)
    expect(hostMatchesAllowlist('https://a.b.github.com', ['*.github.com'])).toBe(true)
    expect(hostMatchesAllowlist('https://github.com', ['*.github.com'])).toBe(false)
    expect(hostMatchesAllowlist('https://evilgithub.com', ['*.github.com'])).toBe(false)
  })

  it('fails closed on unparseable URLs and empty entries', () => {
    expect(hostMatchesAllowlist('not a url', ['api.github.com'])).toBe(false)
    expect(hostMatchesAllowlist('https://x.com', ['', '  '])).toBe(false)
  })
})

describe('mapJsonStrings', () => {
  it('leaves non-plain objects (typed arrays, class instances) untouched', () => {
    const bytes = new Uint8Array([1, 2, 3])
    class Box { v = 'secret-inside' }
    const box = new Box()
    const out = mapJsonStrings({ bytes, box }, () => 'X') as { bytes: unknown; box: unknown }
    expect(out.bytes).toBe(bytes)
    expect(out.box).toBe(box)
  })
})
