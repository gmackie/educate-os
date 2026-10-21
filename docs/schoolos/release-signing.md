# Signed SchoolOS releases

- Status: implemented (SCHO-83)
- Code: `scripts/release/release-signing.ts`, `packages/schoolos-releases`, `packages/schoolos-installer`

A district installs a release only when the root has signed a statement naming the exact bytes of
its `manifest.json` (ADR-0001, threat model T12). The release pipeline produces that statement, a
`SignedReleaseManifest` from `@schoolos/releases`, and writes it beside the manifest as
`manifest.signed.json`. The installer checks it locally against the release keys the district
pins, then checks the manifest bytes against the SHA-256 it names.

## The key

| | |
|---|---|
| Variable | `SCHOOLOS_RELEASE_SIGNING_KEY` |
| Value | The root release key: an Ed25519 private JWK, `{"kty":"OKP","crv":"Ed25519","x":"…","d":"…"}` |
| Where | A masked, protected CI secret on the job that runs `promote-release.ts` |

Generate a key with `SigningIdentity.generate()` and `exportJwk()` from `@schoolos/fleet`, on a
machine you trust, and store the JWK only in the CI secret store. Give districts the public half
(`x`); `pinReleaseKeys` derives the key ID they pin. Rotate with `RootReleaseSigner.rotate`, which
signs the announcement districts accept for the new key.

The scripts never write the key to disk or print it. A malformed value fails with a message that
does not quote it. A key whose public half does not match its private half is refused before
anything is signed.

## Signing in the pipeline

Signing is optional. With the variable unset, `build-release.ts` and `promote-release.ts` produce
an unsigned development release and say so.

With the variable set, both need to know what the release is:

```sh
node scripts/release/promote-release.ts --release-id r000123-abc1234 \
  --version 1.4.0 --channel stable [--minimum-compatible-version 1.2.0] [--valid-days 90]
```

`--version` and `--channel` are required then, so a misconfigured job fails rather than publishing
an unsigned release. `--minimum-compatible-version` defaults to `--version`. The statement is valid
for 90 days by default; the installer accepts it for 30 days past that, so an approved release can
still be installed or rolled back to when the root cannot re-sign. Every D1 migration in the
manifest is listed in the statement as irreversible, and the district acknowledges each one before
it approves the release.

Set the key on the promote job, not the build job. `promote-release.ts` signs the candidate's
manifest bytes after the e2e gate has passed and writes `releases/<id>/manifest.signed.json`
before it publishes the manifest. A candidate that fails the gate is then never signed, so it can
never be installed. If `build-release.ts` signed the release instead, `upload-release.ts` uploads
the statement just before the manifest, and `promote-release.ts` copies it across when it has no
key of its own.

## Installing

The signed path is the default. Pin the release in the install config:

```json
"release": { "mode": "signed", "releaseId": "r000123-abc1234", "version": "1.4.0",
             "trust": { "keys": [{ "keyId": "ed25519-…", "publicKey": "…" }] } }
```

and run the CLI against the release directory. It reads `manifest.signed.json` from beside the
manifest unless `--signed-manifest <file>` names another file; rollback does the same for
`--previous-manifest`.

`"mode": "insecure-pin"` pins an unsigned development build by its SHA-256 only. It is for local
builds made without the key, and the CLI also demands `--insecure-pin` before it accepts one.
Never use it for a release the root has signed.
