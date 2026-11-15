// Release versions: `X.Y.Z` with an optional `v` (tags are `vX.Y.Z`). Prereleases (`v0.3.1-rc1`), build metadata,
// partial versions and leading zeros are not releases: parseSemver returns null, so they are never installed.

const RE = /^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

/** `[major, minor, patch]` of "v0.3.1" or "0.3.1"; null for anything that is not a release version. */
export function parseSemver(v: string): [number, number, number] | null {
  const m = RE.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Negative, zero or positive as `a` is older than, the same as or newer than `b`. Throws for a non-release version. */
export function compareSemver(a: string, b: string): number {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (x === null || y === null) throw new Error(`not a release version: ${JSON.stringify(x === null ? a : b)}`);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}
