# Contributing

Issues and pull requests are welcome.

- Keep it small: each sidecar is one file with plain functions. New services
  follow the same shape (`start*(opts) → endpoint with stop()`).
- Every Kallam-specific or app-specific value is an option, never a constant.
- Run `npm run typecheck && npm run lint && npm test` before opening a PR.
  If you touch process lifecycle, run the integration test too (see README).
- Say which platform you tested on.

## Developer Certificate of Origin

Contributions are accepted under the [DCO](https://developercertificate.org/).
Sign off every commit:

```sh
git commit -s -m "..."
```

which adds `Signed-off-by: Your Name <you@example.com>`, certifying you wrote
the change or otherwise have the right to submit it under Apache-2.0.
