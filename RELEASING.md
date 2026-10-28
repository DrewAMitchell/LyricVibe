# Extension releases

## Version policy

Use `year.quarter.sprint.build`, for example **2026.4.2.0**. This is calendar
versioning, not a promise of SemVer compatibility. Release notes must describe
breaking behavior or stored-data changes explicitly.

- Year and quarter follow the release-preparation date in **America/Chicago**.
- Sprint starts at 1 each quarter: days 1–14 are sprint 1,15–28 sprint 2, and so on.
  Sprint 7 contains the remaining 6–8 days; quarter boundaries take precedence over
  an uninterrupted fortnight cadence.
- Build starts at 0 and increases globally for every prepared release candidate.
  It never resets at a sprint, quarter or year boundary. Gaps from abandoned
  candidates are valid. Ordinary development builds do not consume numbers.
- The full version and exact Git commit identify the release. Each Chrome numeric
  component is limited to 65535. Exhaustion stops preparation; never wrap a counter.
- `extension/manifest.json` owns the extension version. Its `version_name` uses the
  same unpadded value. npm requires SemVer, so its development-tool package uses
  `2026.4.2-build.0`; the script updates package.json and both lockfile version fields.
- Tags use `v2026.4.2.0`. Preserve tags and released artifacts permanently; never
  reuse a version or replace its ZIP with different bytes.

Chrome rules: <https://developer.chrome.com/docs/extensions/reference/manifest/version>.

## Prepare from the filtered public branch

1. Use a separate checkout of the public repository's main branch. Fetch/pull
   main and tags before work. Review and port only selected development changes;
   **never merge the private development branch or push all refs**. The release
   tool requires ancestry from the audited public baseline in release-policy.json.
   Keep public Git author attribution on the maintainer's GitHub noreply address.
2. Review the proposed public diff for lyrics, song-specific exports, recordings,
   screenshots, recoveries, private notes, paths, identities and secrets. Git
   ancestry and an artifact allowlist cannot establish that newly committed source
   is safe by themselves. Commit the reviewed source first; the checkout must be
   clean, including untracked non-ignored files.
3. Run `npm run release:version`. It reads current remote release tags, selects
   today's quarter/sprint, and increments the greatest current/published build
   counter. The initial migration from 0.5.0 starts at 0. Network failure aborts.
   Review and commit the three version-file changes with `Prepare release <version>`.
   Keep abandoned candidate commits, so their build IDs are not silently reused.
   One maintainer owns release allocation at a time; do not prepare in parallel.
4. Run `npm run release:package` (or the VS Code release launch entry). It exports
   exact committed source to a new ignored directory, installs the lockfile,
   runs unit/package tests, typecheck, build, and isolated Chrome save/startup/sync
   regressions. Requires Node 22+, npm, Python 3.11+ and installed Chrome. This is a
   native local release qualification path; no live user browser is controlled.
5. Inspect `.verification/releases/v<version>/`: extension ZIP, `SHA256SUMS`, and
   `release.json` with the exact source commit, lockfile digest and every member's
   digest. Only the exact reviewed release-files.json inventory is admitted.
   A missing/extra asset or a common private-data marker stops packaging. This
   bounded check complements human source review; it is not a universal secret
   detector. Packaging refuses an existing output directory. Failed source-build
   folders remain under .verification for diagnosis and follow local retention.

The ZIP has manifest.json at its root. It contains only the browser extension,
including its licensed pronunciation data and browser inference runtime. Native
Python tools, recordings, browser storage, model weights and repository history
are not in the extension ZIP. Source remains available separately on GitHub.

## Publish one reviewed candidate

Write release notes describing changed behavior, compatibility/data changes,
verification and known limitations. Verify the candidate receipt's source commit
equals the release checkout HEAD and verify its ZIP SHA256. Publish from that
exact clean checkout, using an explicit version tag and branch ref:

```text
git tag -a v2026.4.2.0 -m "LyricVibe 2026.4.2.0"
git push --atomic https://github.com/DrewAMitchell/LyricVibe.git HEAD:refs/heads/main refs/tags/v2026.4.2.0
```

Substitute the prepared version. Never force either ref. The atomic push prevents
a stale competing branch or existing tag from partially publishing the release.
If another release wins, fetch it, reconcile the selected public changes, allocate
a new build number and regenerate the candidate. Do not move the losing tag to new
bytes. `release:package` also refuses already-published build numbers.

Create a GitHub Release for that existing tag, add the reviewed notes, and attach
the exact ZIP, SHA256SUMS and release.json. Use a prerelease label while installation
and stored-data upgrade qualification remain incomplete. Re-read the remote tag
and release assets and compare their hashes before reporting publication complete.
Preparing or packaging never pushes a ref or creates a GitHub Release automatically.

## Install, upgrade and recover

Download the ZIP and compare its SHA256 with the published receipt. A checksum
checks integrity; it is not an independent publisher signature. These releases
use manual unpacked installation, not unattended updates or Chrome Web Store
distribution. Extract to a persistent folder and load that folder through
chrome://extensions → Developer mode → Load unpacked.

For an existing profile, export important scores and maps first. Stop any capture,
save or deliberately park edits, and confirm the extension's worker is idle before
reloading. Keep the extension's existing unpacked path/identity stable; changing
identity can make existing browser storage appear missing. Use a copy of the prior
extension folder for rollback and keep user data separate from release files.
Do not clear browser storage as part of an upgrade. Verify cold startup, a saved
song/map, a save/undo and current version after reload. Source-only synthetic tests
do not prove a user's stored-data migration. For a public corrective release,
revert the affected code and allocate a **higher** version; never move an old tag.

## Changes to this process

Update release-files.json deliberately when adding/removing browser assets and
review the output before committing the inventory. Keep the package command and
VS Code launch entry aligned. The local private source checkout may retain these
tools for development, but release commands intentionally reject its ancestry.
