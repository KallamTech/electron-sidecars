# Changelog

## 0.3.0

- New `supervise()`: restarts a long-running child (worker, queue listener) with backoff when it exits unexpectedly; `stop()` ends it for good.
- README: Ollama memory note. A model on the MLX runner is never evicted (Ollama 0.40), so a load that doesn't fit beside it hangs; how to avoid it.

## 0.2.0

Secure by default. Breaking: every service now needs an explicit auth choice.

- **Postgres:** scram-sha-256 everywhere. `password` is required unless `trust: true`. An existing trust-auth cluster is converted on first start with a password (single-user `ALTER ROLE`, then `pg_hba.conf` rewritten), and a password the cluster rejects is reset the same way. Unix socket permissions are 0700. New `setPassword(role, pw)`, and `url(role, password)`.
- **PostgREST:** `jwtSecret` is required unless `allowAnonymous: true`. New `unixSocket` (mode 600, parent dir 0700, no TCP listener; a leftover instance is found via a pidfile and replaced) and `corsAllowedOrigins`. The endpoint gains `socketPath`; `port` is `null` on a socket.
- **Redis:** new `password` (`requirepass` over stdin, not argv). An instance on the port that rejects it is replaced instead of adopted. New `redisAccepts()`.
- **Electron:** new `persistentSecret(name)`, a safeStorage-encrypted random secret under userData.
- README: Security section. Example app uses the secure defaults.
- CI: actions pinned by commit, read-only token by default, npm pinned, publishing gated on the `npm` environment.

## 0.1.0

Initial release.
