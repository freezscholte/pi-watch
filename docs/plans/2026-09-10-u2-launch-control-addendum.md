# U2 launch-control development schema policy

## Approved decision

The user selected **Fresh development schema** for the durable cancellation and pre-launch control needed by U2. This retains the no-migration approach during pre-release development.

- Bump the private database schema when adding the control state.
- Preserve and refuse older development databases. Do not migrate, modify or delete them automatically.
- Use a fresh development store with the current schema. There is no data-adoption or automatic command-replay path.
- Keep newer/unknown-schema refusal, read-only WAL-aware inspection, private-path checks and diagnostic redaction intact.
- Keep the package private at version `0.0.0`; this is not a release or installation guarantee.

This decision supplements the existing v0.1 contract without changing command lifetime, ownership, deadlines, best-effort cleanup or result-evidence requirements.

## U2-W2 scope

Add durable owner-scoped cancellation requests and a one-time pre-launch decision to the [storage foundation](../u1-storage.md). The compiled [store worker](../u1-worker.md) must expose the same behavior without blocking control timers.

A cancellation request is not proof of suppression or process termination. A successful first pre-launch decision may authorize one live original runner to send its one-time shell-start grant. Reading a previous decision, replaying a request, losing a response or reopening the store must never grant fresh execution authority.

Cancellation observed before the decision takes precedence over deadline suppression. Requests after authorization remain pending for the later live runner/guardian protocol; they do not promise zero command side effects. Failures or ambiguity at the decision point must fail closed before a grant is sent.

The exact private records, interface results and transaction layout are implementation decisions to settle before authoring. They must preserve established evidence and atomic result/notice behavior. U2-W2 does not launch commands, introduce a guardian, signal processes, add a scheduler or change delivery behavior.

## Verification boundary

Tests must cover owner and capability fences, repeated/concurrent requests, cancellation versus decision ordering, deadline precedence, one-time authorization, terminal/previously-decided behavior, commit uncertainty and reopen. Older development stores must be refused without application mutation, and current stores must still bootstrap atomically.

This slice does not earn command execution, quit survival, descendant cleanup or Pi integration claims. It stops for local verification/review and separate shipping approval.
