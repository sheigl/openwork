# Contributing to OpenWork

Thanks for contributing. Two things keep this project's licensing clean —
please read them before opening a pull request.

## 1. Developer Certificate of Origin (DCO)

Every commit must be signed off, certifying the
[Developer Certificate of Origin v1.1](https://developercertificate.org/):

```
git commit -s -m "your message"
```

This adds a `Signed-off-by: Your Name <your@email>` trailer asserting that
you wrote the change (or otherwise have the right to submit it) and that you
may submit it under this repository's licenses. Pull requests with unsigned
commits cannot be merged.

## 2. How your contribution is licensed

This repository is **MIT licensed throughout** — see [LICENSE](./LICENSE).
Contributions are accepted under the same MIT license (inbound = outbound),
certified by your DCO sign-off. There is no source-available directory and no
second license to track.

> **Upstream note.** OpenWork used to be open core, with a Contributor License
> Agreement required for code under `ee/` because that code was sold under
> subscriptions and scheduled to convert to MIT. This fork deleted `ee/`, so the
> split is gone and the CLA is no longer required for any contribution. The CLA
> texts remain in `legal/` only for reference. If you maintain a fork of this
> repository and want to reintroduce a source-available tier, keep those
> documents and require the CLA again for the directories it covers.


If you are contributing as part of paid work, a work trial, or on behalf of
an employer, make sure a signed agreement covering intellectual property
assignment is in place with Different AI, Inc. **before** your first pull
request — ask your contact at OpenWork if you are unsure. Maintainers will
not merge substantive contributions from paid engagements without one.

## Practical notes

- Use pnpm, never npm or yarn.
- Keep diffs as small as possible; propose the simpler solution.
- Runtime-observable changes need test evidence on the PR (see `AGENTS.md`).
- Never commit secrets, credentials, or personal data.
