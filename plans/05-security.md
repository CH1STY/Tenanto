# 05 — Security

Security is a first-class requirement. Defense in depth across auth, data, and transport.

## Authentication

- **Auth.js (NextAuth v5)** with the **Credentials** provider.
- Passwords hashed with **bcrypt** (salted); only `passwordHash` is stored.
- **JWT sessions** signed with `AUTH_SECRET`; short-lived access tokens.
- Session cookies are **httpOnly**, **secure** (in prod), **sameSite=lax**.
- Only users with `role ∈ {SUPER_ADMIN, MANAGER}` and `isActive = true` may sign in.

## Authorization (RBAC)

- Middleware protects all `/dashboard` and API routes.
- **Server-side role checks** on every mutating action — never trust the client.
- Sensitive actions (role changes, deletes) re-verify role against the DB.

## Input validation

- **Zod** schemas validate every request body, query, and form input.
- Reject unexpected fields; coerce/whitelist types.
- Guards against **NoSQL injection**: never pass raw user objects into Mongoose
  queries; reject query-operator keys (`$gt`, `$ne`, `$where`, etc.).

## OWASP Top 10 mapping

| Risk                          | Mitigation                                                         |
| ----------------------------- | ------------------------------------------------------------------ |
| A01 Broken Access Control     | RBAC middleware + per-action server checks                         |
| A02 Cryptographic Failures    | bcrypt hashing, secrets in env, TLS in prod                        |
| A03 Injection                 | Zod validation, Mongoose parameterized queries, operator filtering |
| A04 Insecure Design           | Least-privilege roles, append-only history                         |
| A05 Security Misconfiguration | Security headers, disabled verbose errors in prod                  |
| A07 Auth Failures             | Strong hashing, rate-limited login, generic error messages         |
| A08 Data Integrity            | Signed JWTs, unique indexes, validated writes                      |
| A09 Logging Failures          | Audit log for role changes & deactivations                         |

## Hardening checklist

- [ ] Rate limit login and sensitive endpoints.
- [ ] Security headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options).
- [ ] CSRF protection on state-changing requests.
- [ ] Generic auth error messages (no user enumeration).
- [ ] Enforce strong password policy on create/promote.
- [ ] Store secrets only in `.env` (never committed).
- [ ] Principle of least privilege for the MongoDB user.
- [ ] Audit trail for promote/demote, activate/deactivate, deletes.
