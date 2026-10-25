# Vendored Hall Monitor packages

Release: [gmackie/hall-monitor v0.3.0](https://github.com/gmackie/hall-monitor/releases/tag/v0.3.0)

These tarballs are the release's own assets, copied byte for byte. `@educateos/ai-guard` depends on
the client and its contracts, and `@educateos/discussions` on the contracts, with `file:` specifiers, and the `overrides` in `pnpm-workspace.yaml`
point the client's transitive `@gmacko/hall-monitor-contracts@0.3.0` at the same file, because no
registry serves it and pnpm refuses URL dependencies of dependencies. `pnpm-lock.yaml` records each
tarball's sha512 integrity, so an edited file fails `pnpm install --frozen-lockfile`.

| Asset | SHA-256 (matches the release asset digest) |
|---|---|
| `gmacko-hall-monitor-client-0.3.0.tgz` | `ea87a4e268770bef916dca336ef93079a8a02a996c39fbdee5388ec2bf823932` |
| `gmacko-hall-monitor-contracts-0.3.0.tgz` | `9955577153ac5ee52b4aebb726cfe54593ca8b1c2b1d677e5e98f2a2c5da7c7d` |

Only these two are vendored: the client's only `@gmacko` dependency is the contracts, and the
guard and discussions use nothing else (costing, policy, evaluators, Clef and core run inside the Hall Monitor
Worker). Both ship TypeScript source (`exports: ./src/index.ts`), which wrangler's esbuild bundles
and `tsc` checks like workspace source; their one runtime dependency, `zod`, resolves to the
workspace's catalog version.

## Updating

1. `gh release download <tag> --repo gmackie/hall-monitor --pattern 'gmacko-hall-monitor-{client,contracts}-*.tgz'`
   into an empty directory, and check each tarball's `package/package.json` for new `@gmacko`
   dependencies (vendor those too).
2. Compare `shasum -a 256` of each file with the digest on the release page
   (`gh release view <tag> --repo gmackie/hall-monitor --json assets`), then replace the files
   here and update the table above.
3. Update the file names in `packages/educateos-ai-guard/package.json`, `packages/educateos-discussions/package.json` and
   `pnpm-workspace.yaml`,
   and run `pnpm install`.
