# Messaging upgrade audit and implementation plan

The November 1 audit found MongoDB-backed DMs, idempotency keys with a unique
index, chronological cursors, authenticated sockets, replies, edits, image
attachments, mute, notifications, and calls. Existing conversations have no
request status and must remain accepted. No migration or production data reset
is needed to preserve that behavior.

File-by-file plan:

- `backend/models/Conversation.js`: embedded request state, initiator and
  recipient, an atomic first-message reservation, archive preferences, indexes.
- `backend/models/Message.js`: delivered/read timestamps alongside existing
  deliveryState/readBy. Keep existing types and deduplication index.
- `backend/models/User.js`: opt-out presence and opt-in last-seen privacy.
- `backend/utils/messaging.js`: shared membership, accepted-state and receipt
  guards; legacy documents without requestStatus remain accepted.
- `backend/routes/conversations.js`: inbox/request/archive filtering, request
  accept/decline/block, first-message limits, fetch delivery, archive preferences,
  private cloud attachments. Keep existing paths for client compatibility.
- `backend/socketHandler.js`: reuse request/block guards for presence, receipts,
  typing and calls; persist last seen without exposing it to strangers.
- `backend/utils/messageStorage.js` and `backend/models/Attachment.js`: private
  S3-compatible media keys; backend streams authorized objects. Production image
  uploads require cloud configuration; do not silently use ephemeral storage.
- `backend/models/PushSubscription.js` and `backend/routes/push.js`: authenticated,
  encrypted, revocable push-subscription storage; no unimplemented push claim.
- `frontend/messages.html`, `frontend/js/messages.js`, `frontend/css/messages.css`:
  inbox/request/archive tabs, request actions, disabled pending composer,
  accurate receipt labels, explicit privacy/notification controls, search users.
- `backend/test/message-requests.test.js`: first request, concurrent sends,
  retries, offline fetch/read, acceptance/decline/block, legacy conversations,
  archived conversations and unauthorized access. Keep existing integration tests.

External dependency: no storage account exists yet. S3-compatible configuration
will be documented; production image sending must remain unavailable until a
private bucket and credentials have been configured. Existing text messages and
accounts remain usable. Web Push delivery/VAPID infrastructure is preparation
only, not a working offline push service.

## Implementation and validation

Requests are embedded in Conversation (one canonical participant key), rather
than a second collection that could drift out of sync. New DMs are pending;
legacy documents without requestStatus are treated as accepted. A named partial
unique Message index permits exactly one introduction, even for concurrent sends.
No existing message or conversation data is rewritten. New indexes are awaited
before the production listener opens.

Inbox: `GET /api/conversations?section=inbox|requests|archived`.
Resolve: `POST /api/conversations/:id/request/accept|decline|block`.
Preferences: `PATCH /api/conversations/:id/preferences` supports archived/muted/pinned.
Privacy: `GET/PATCH /api/conversations/settings`. Existing history/send/read/state
paths remain unchanged. Fetching accepted history marks delivered messages;
opening the visible conversation marks read through the displayed cursor.
Pending requests reveal neither delivery/read receipts nor typing/presence/calls.

Production message images require a private S3-compatible bucket. Add these in
Render Environment, not source control:

- MESSAGE_S3_BUCKET
- MESSAGE_S3_ACCESS_KEY_ID
- MESSAGE_S3_SECRET_ACCESS_KEY
- MESSAGE_S3_REGION (AWS region or `auto` for R2)
- MESSAGE_S3_ENDPOINT (R2 endpoint; omit for standard AWS S3)

Keep the bucket private and grant the application only object read/write access.
Do not configure public bucket delivery. Validated images are staged in an OS
temporary directory, uploaded, and removed locally. Authenticated backend routes
stream objects after checking accepted membership and blocks. No storage account
was available: real-cloud upload is not claimed. A local mock S3 service tests
upload/read behavior; production-without-storage tests verify uploads fail safely.
Legacy local attachments remain readable where their old files still exist; this
change cannot recover files already lost on Render's free ephemeral disk.

Push subscription preparation: `POST /api/push/subscriptions`, `DELETE
/api/push/subscriptions`. Subscriptions are scoped to the authenticated user,
validated against supported push providers and encrypted with AES-GCM using a
key derived from the backend secret. This does not implement offline Push delivery;
VAPID, service-worker registration and a delivery worker are future work. A JWT
secret rotation would require subscriptions to be registered again.

Validation: 58 integration tests passed against isolated local MongoDB, including
an actual Express/Socket.IO server restart, offline fetch/reply, request acceptance,
decline and block, duplicate introduction races, legacy DMs, privacy, archive,
encrypted subscription revocation, and a local mock S3 adapter. Existing social,
authentication, messaging, call and location tests pass. Browser smoke test used
synthetic accounts only in a separate local preview database: Requests badge,
pending preview with disabled composer, accept, reply, and inbox move. No fake
conversations or messages were inserted into the production database.
