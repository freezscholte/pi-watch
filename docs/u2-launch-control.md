# U2: durable launch control

This internal layer records owner cancellation requests and a one-time pre-launch decision. It builds on [U1 storage](u1-storage.md) and the [compiled store worker](u1-worker.md). It does not execute commands, signal processes or implement a guardian.

## Development schema 2

The private schema is now **2**. Under the approved [fresh development schema policy](plans/2026-09-10-u2-launch-control-addendum.md), older development databases are preserved and refused, not migrated or deleted. Use a fresh private store path for development. Newer schemas still require a compatible executable.

Refusal keeps the existing read-only WAL-aware inspection and private-path rules. SQLite's normal WAL/SHM coordination is allowed; no application migration, permission repair or data-adoption path is added. The package remains private at version `0.0.0`.

## Control interface

Both the synchronous store and asynchronous client expose:

| Operation | Meaning |
| --- | --- |
| `requestCancellation(ownerUuid, jobId)` | Records the first owner request, or reports `already_recorded` / `already_terminal`. The original timestamp is retained. |
| `decideLaunch(ownerUuid, jobId, claimId, runnerToken)` | Checks the owner, matching durable claim and creator capability, then serializes the first launch decision. |
| `observeJob(ownerUuid, jobId).control` | Reads historical cancellation/decision state within the existing coherent observation transaction. This is not a grant. |

A cancellation request does not change result evidence, publish a notice or establish suppression or process death. Requests are allowed before or after claim. Terminal state takes precedence over recording another request.

Only a successfully received **`authorized_now`** result permits the later live original runner to send its one-time shell-start grant. `already_decided`, `precluded`, historical `authorized` data and all errors grant no fresh permission. Storage cannot prove that a caller is still the original live actor; the later original-channel protocol must enforce that discipline.

## Ordering and atomicity

The decision runs under a write transaction. An existing decision is immutable and is never reassessed. For a first eligible decision, cancellation takes precedence over the immutable stored deadline; otherwise authorization is recorded. Transaction order—not comparison of request timestamps—determines which side of a cancellation race wins.

Authorization records control state only. It is not shell-launch evidence and does not create a result notice. Cancellation after authorization remains a pending request for the future live runner/guardian path, not retroactive suppression or a zero-side-effect guarantee.

Suppression atomically records the decision, appends a finalized suppression result and pending notice, and settles the job. Earlier result revisions, notices and stale-witness records remain intact.

Pure initial-fact uncertainty may precede the original runner's first decision, and heartbeat advancement alone does not prevent it. Finalized state or established noninitial result facts preclude a fresh decision without erasing those facts. Preclusion does not prove execution or death. A missing control row is corruption, not permission to invent fresh state.

## Failures and verification

Potentially committed control calls whose worker response is lost return `StoreWriteError('unknown')`. Post-commit failures retain a committed receipt. Neither permits a grant or automatic command replay; the future runner must abandon the grant path on error. Clone failures before handoff and new calls after worker loss remain ordinary validation/unavailable errors. Reservation-specific candidate identity behavior is unchanged.

Tests cover owner/claim/capability fences, competing decisions, both cancellation orderings, exact deadlines, timestamp zero, history preservation, rollback/post-commit failures, committed-operation response loss, older-schema refusal and compiled-worker parity. Private-copy mutation checks verify the one-grant fence, typed control-loss errors and write disabling.

JavaScript commit hooks test transaction boundaries; they are not hardware or power-loss proof. Existing native SQLite fault tests remain in the suite. Real command side effects, output capture, guardian cleanup and Pi lifecycle validation remain later U2/integration work.
