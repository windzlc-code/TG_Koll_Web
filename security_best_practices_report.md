# Authentication Security Review

Date: 2026-07-29

Scope: verified-email registration, username/email password login, Google OAuth,
administrator authentication controls, and the related public UI.

## Executive summary

No P0 issue was found. The review found four P1 issues and several P2 issues.
The Google entry point should only be enabled after the OAuth configuration and
the P1 fixes that protect the public endpoints are deployed.

Fixed in this review:

- OAuth start requests are rate limited, pending flows are capped per IP, and
  expired/old consumed flows are deleted.
- The OAuth callback rechecks the runtime and environment policy before token
  exchange.
- Verification-code failure counters are committed before returning an HTTP
  error, so the five-attempt limit now works.
- Failed password attempts are committed, account locks are temporary, and
  expiry restores the account without setting the permanent `is_disabled` flag.
- Verified-email registration and verified-email password setup no longer copy
  the user's plaintext password into the reversible password vault.
- OAuth callback errors are shown to the user and removed from the URL.

## P1 - High

### AUTH-001: Reversible storage of customer passwords remains in legacy/admin paths

- Evidence: `webapp/server.py:763-815`, `webapp/server.py:17915-17916`,
  `webapp/server.py:19151-19165`, `webapp/server.py:21903-21914`,
  `webapp/server.py:22526-22535`, `webapp/server.py:22981-22997`,
  `webapp/server.py:23083-23099`.
- Impact: compromise of both the database and vault key, or abuse of a
  privileged password-reveal path, exposes users' original passwords. Password
  reuse can extend the breach to unrelated services.
- Current mitigation: new verified-email registration and verified-email
  password setup now store only the password hash.
- Required fix: migrate all remaining customer password creation/change paths
  to one-way hashing only. Replace password reveal/recovery with an expiring
  reset token or temporary password and require a change at next login.
- False-positive note: encryption at rest reduces single-component exposure,
  but it does not make reversible password storage an acceptable authentication
  design.

### AUTH-002: Verification attempt limits were rolled back with the error response

- Evidence: `webapp/auth_email.py:355-375`; fixed call sites are
  `webapp/server.py:18123-18131` and `webapp/server.py:19090-19098`.
- Impact: before the fix, an attacker could submit unlimited guesses against a
  six-digit verification code because `attempt_count` remained zero.
- Fix applied: commit the failure counter and invalidation before raising the
  HTTP error. A regression test now proves five failures persist and invalidate
  the challenge.

### AUTH-003: Google OAuth start could grow SQLite without bound

- Evidence: fixed route `webapp/server.py:18265-18347`.
- Impact: an unauthenticated client could create unlimited authorization-flow
  rows and consume database/disk capacity.
- Fix applied: process-level IP rate limit, a persistent cap of ten active
  flows per IP, and cleanup of expired and old consumed flows before insert.
- Residual risk: deployments with many application processes should move the
  short-window rate limiter to a shared store or reverse proxy.

### AUTH-004: Password failure state did not persist and lock semantics mixed temporary and permanent state

- Evidence: fixed path `webapp/server.py:18770-18848`.
- Impact: the database lockout and alert controls did not work because the
  surrounding error rolled back their updates. The intended implementation
  also set `is_disabled`, which would have required administrator recovery if
  it had persisted.
- Fix applied: commit failed-attempt state, use `locked_until` for a temporary
  lock, never set permanent disablement for password failures, and reset the
  failure state after the lock expires.

## P2 - Medium

### AUTH-005: Google callback did not enforce a newly disabled global switch

- Evidence: fixed callback `webapp/server.py:18349-18398`.
- Impact: an authorization flow started before an administrator disabled Google
  login could still complete.
- Fix applied: recheck the complete login policy before token exchange and
  consume/reject the flow when disabled.

### AUTH-006: Google login unconditionally revokes existing customer sessions

- Evidence: `webapp/server.py:18192-18212`.
- Impact: a Google login on a second device silently signs out the current
  device, while password login uses an explicit session-conflict/takeover flow.
- Recommended fix: apply the same conflict policy to both authentication
  methods, or document and expose a consistent single-session policy.

### AUTH-007: Administrator auth-method changes lack step-up verification

- Evidence: `webapp/server.py:22641-22648` and
  `webapp/server.py:22741-22747`.
- Impact: a stolen but still-valid administrator session can disable login
  methods or unlink a Google identity without reauthentication.
- Recommended fix: require `_require_admin_step_up` for both operations and
  retain the existing same-origin protection.

### AUTH-008: Email registration exposes account existence

- Evidence: `webapp/server.py:17962-17967` and
  `webapp/server.py:18055-18059`.
- Impact: attackers can enumerate registered email addresses.
- Recommended fix: make the send endpoint return the same generic response for
  existing and new addresses, while suppressing delivery for existing users.

### AUTH-009: Failed resend invalidates the previous usable verification code

- Evidence: challenge creation starts at `webapp/auth_email.py:128`; delivery
  failure is handled at `webapp/server.py:18003-18008`.
- Impact: a temporary SMTP failure can invalidate the user's previous valid
  code, causing unnecessary lockout and retry traffic.
- Recommended fix: invalidate the previous challenge only after the replacement
  message is accepted by SMTP, or restore the previous challenge on delivery
  failure. Count delivery failures in a bounded IP/provider retry budget.

### AUTH-010: OAuth failures were not visible to the user

- Evidence: server redirect `webapp/server.py:18182-18190`; fixed UI handling
  `webapp/static/assets/opc/script.js:656-702`.
- Impact: users received an empty login dialog after cancellation, expired
  state, identity conflict, disabled account, or provider verification failure.
- Fix applied: map safe error codes to text-only messages and remove the error
  parameter with `history.replaceState`.

## Verification

- Targeted authentication/frontend suite: 17 passed, 4 subtests passed.
- Expanded authentication regression: 139 passed, 3 skipped, 21 subtests passed.
- JavaScript syntax check: passed.
- `git diff --check`: passed; only existing line-ending normalization warnings
  were reported.
