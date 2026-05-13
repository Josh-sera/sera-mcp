# Security Policy

## Reporting a Vulnerability

Please don't open a public issue for security findings.

Use [GitHub's private security advisory](https://github.com/Josh-sera/sera-mcp/security/advisories/new) or contact the maintainer (see profile).

We aim to acknowledge reports within 48 hours and ship fixes for verified high/critical findings within 7 days.

## Supported Versions

Only the latest release on `main` is supported. Past tags are not patched in place.

## Threat Model

This MCP is an **agent-accessible financial tool**. Threat model assumptions:

- The MCP host (Claude Code, Cursor, etc.) is treated as **untrusted input source**. Malicious prompts can become tool arguments.
- Environment variables are **policy boundaries**. Malicious install snippets may set them. The server fails closed on invalid values.
- `SERA_SIGNER_MODE=local` raises severity for any cap bypass — the server can sign + submit transactions. External mode is the safe default.
- Sera's API + smart contracts are out of scope; we trust HTTPS to canonical sera.cx hosts (verified at boot).

## Hardening Posture

- Hardcoded base URLs by network. `SERA_BASE_URL` is ignored unless `SERA_BASE_URL_ALLOW_CUSTOM=true` AND (for non-sera.cx hosts) `SERA_BASE_URL_ALLOW_NON_SERA=true`.
- All policy env vars validated at boot (NaN, out-of-range → process exits).
- Daily volume cap persists to SQLite when enabled (cross-restart enforcement).
- Quote UUIDs bound to route_params; local signer refuses unknown UUIDs and rejects mismatches.
- EIP-712 output tolerance defaults to 0bps (no silent loosening).
- Maximum quote expiration capped (`POLICY_MAX_EXPIRATION_SECONDS`, default 600s).
- SQLite history file chmod 0600; owner_address SHA-256 hashed by default.
- redirects disabled on Sera REST calls (`maxRedirections: 0`).
- CI runs `npm audit --audit-level=high`, gitleaks secret scan, and CodeQL on every push.

## Known Out-of-Scope Items

- The MCP does not perform on-chain settlement directly. The agent's wallet signs and submits.
- Sera backend rate-limiting and audit are Sera's responsibility.
