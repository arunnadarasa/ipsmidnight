# Fix the SDK install failure (group 3) + copy button for the runner log

## What the log actually says

Group 3 failed with an npm resolution error, not memory:

```text
npm error code ETARGET
npm error notarget No matching version found for @midnight-ntwrk/ledger-v9@^0.1.0-alpha.1
```

This is a broken published package, not a runner problem. The pinned
`@midnight-ntwrk/compact-js@2.5.3` declares a dependency on
`@midnight-ntwrk/ledger-v9@^0.1.0-alpha.1`, and that version range does not
exist in the registry (only `1.0.0-rc.3` and `1.0.0-rc.4` are published). Every
neighbouring compact-js release (2.4.x, 2.5.0, 2.5.1, 2.5.5-rc.x) has no
`ledger-v9` dependency at all — 2.5.3 is the odd one out.

The rest of the run is healthy: disk is 5% used, groups 1 and 2 install in under
a second, curl and the bundle unpack fine. So the memory/staging work from the
previous round did its job; this is the next, unrelated wall.

## The fix

Pin compact-js to **2.5.1** — the version `@midnight-ntwrk/midnight-js-protocol@4.1.1`
already resolves for itself (visible in the same log at line 42), so the runner
ends up with one copy instead of two conflicting ones. Its dependency set
(`ledger-v8@^8.0.3`, `compact-runtime@0.16.0`, `effect`, `@effect/platform`)
resolves cleanly.

A stale `node_modules`/lockfile on the volume from the failed attempt can pin the
bad range, so the bootstrap removes `package-lock.json` before group 3 when the
recorded SDK pin changes, and the toolchain marker version is bumped so an
already-"prepared" runner re-installs rather than being skipped.

## Also: copy button for the runner log

Add a **Copy log** button to the runner log header (next to the "RUNNER LOG"
label), copying the full tail to the clipboard with a "Copied." toast — matching
how the contract address and tx already behave. It stays visible whether the log
panel is expanded or collapsed, so a failure can be pasted without scrolling
through it on a phone.

## Technical notes

- `src/lib/midnight/shared.ts`: `DEP_GROUPS` group 3 → `@midnight-ntwrk/compact-js@2.5.1`;
  bump `RUNNER.artifactVersion` so prepared runners re-bootstrap.
- `src/lib/midnight/runner.server.ts`: drop a stale `package-lock.json` in
  `/work/app` before the dependency groups install.
- `src/components/deploy/ContractLifecycle.tsx`: copy button in `LogTail`.
- No contract change, no re-compile, no migration. The Fly stack stays up.

## Verify

1. Press **Prepare runner** — group 3 completes instead of ETARGET, and the
   timeline reaches **Toolchain ready**.
2. Press **Deploy contract** and confirm the address/tx appear.
3. **Copy log** puts the full runner log on the clipboard.
