/**
 * Semver comparison helper. Lives in src/server/update/ (dependency-light
 * zone) so unit tests and the boot guard can import it without pulling in
 * config/db/sse.
 */

/**
 * Compare two semver strings (major.minor.patch).
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number)
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    const na = pa[i] ?? 0
    const nb = pb[i] ?? 0
    if (na < nb) return -1
    if (na > nb) return 1
  }
  return 0
}
