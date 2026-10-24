> Historical 2.0 report. Current behavior, privacy rules and deployment instructions are in [PicShare 3.0](PICSHARE-3.md).

# PicShare 2.0 implementation audit

The existing app is static HTML/CSS/JavaScript served by Express (`backend/server.js`), with MongoDB, bearer JWTs, bcrypt and Google ID-token verification. `npm start` starts the same-origin frontend and backend. No bundler, lint command or type checker exists. Socket.IO, messaging, WebRTC UI and location routes were already present as uncommitted work and are being preserved and repaired.

Initial defects: global location and presence broadcasts; unauthorized typing; delivery inferred from presence; client-dependent message publication; conflicting sparse/partial index; cross-conversation reply references; pagination loses equal-timestamp messages; live-session payload ignored; no TURN endpoint; caller/recipient busy and membership checks incomplete; receiver generates an offer; early ICE discarded; test suite uses application DB. Uploads are local and must use a durable volume. AI is absent.

## Implementation checklist
- [x] Repair persistent message delivery, receipts, pagination and recovery (limitations below)
- [x] Apply block policy across messaging, calls and location
- [x] Repair call authorization, state transitions, TURN credential boundary and media lifecycle; real-device acceptance pending
- [x] Remove global location relay; support authorized live viewing and revocation
- [x] Add optional photo suggestion adapter and editable UI; live provider acceptance pending
- [x] Isolate integration tests and add negative security tests
- [x] Document configuration, manual acceptance and remaining limitations

## Delivered in this update

- Preserved vanilla frontend, existing routes, bearer JWT login/session restoration, bcrypt passwords, Google sign-in, profiles, follows, posts, likes and comments. Auth middleware now distinguishes database errors from expired sessions. Uploads check file signatures as well as MIME and size. The tracked environment example contains placeholders only. A compatible body-parser security patch was applied.
- Canonical direct conversations; server publication after MongoDB persistence; sender-scoped idempotency IDs; concurrent retry protection; recipient-acknowledged delivery; visibility-aware read receipts through the displayed message cursor; authoritative inbox unread counts derived from message records; stable `(createdAt, _id)` history pagination and forward reconnect recovery. Socket-only delivery is never permanent storage.
- Message replies, editing, soft deletion, reactions, private image attachments, shared-post previews and links, call summaries. Image attachment uploads no longer accidentally create public feed posts. Attachments have conversation/owner records and authenticated read endpoints; guessing a filename in another conversation does not grant access.
- Profile Message, Block and Unblock controls. Either side's block prevents new messages, calls and location sharing. Blocking revokes current sharing and terminates calls. Historical text messages remain accessible to their participants.
- Authenticated conversation joins, contact-scoped multi-tab presence, authorized typing with expiry, per-event socket limits, socket token expiry, persistent notification records, recipient-only notification APIs and opt-in generic browser notifications while Messages is open.
- Real browser WebRTC offer/answer/ICE implementation repaired: only caller offers, early ICE queues, explicit recipient acceptance, multi-tab media consent guard, busy checks for both users, ring and connection deadlines, connected heartbeat, disconnect cleanup, server call history and short-lived coturn credentials. Signaling is transient. Media is never uploaded or recorded.
- Explicit one-time location preview/cancellation; live session validation; authorized viewer with map, update time and expiry; recipient-only invalidation events followed by authenticated fetch; expiry checks on reads and writes; periodic coordinate minimization; Stop Sharing revocation and local watcher cleanup. If revocation fails, tracking stops locally and the UI says to retry server revocation.
- Optional server-side photo-suggestion adapter with consent, timeout, rate limit, response-size validation and editable caption/hashtag/alt-text fields. Missing credentials return a useful error without disabling publishing. Private messages and locations are never sent to this adapter.
- Mobile call buttons restored; message retries, action controls, keyboard pagination, accessible labels and map viewing. Browser verification confirmed local login, user search, sending, persistence after reload and visible mobile call controls.

## Run, check and test

```sh
npm --prefix backend ci
# On a fresh setup only; preserve an existing .env:
cp backend/.env.example backend/.env
# Fill configuration before starting.
# Existing deployments with earlier communications indexes: back up MongoDB, then run:
npm run migrate
npm start
# Development server:
npm run dev
# Syntax verification:
npm run check
# Full integration suite; use a disposable, separate MongoDB database:
TEST_MONGODB_URI=mongodb://127.0.0.1:27017/picshare_test npm test
```

Open `http://localhost:4000`. Express serves the frontend and `/socket.io`; there is no bundler, build step, TypeScript compiler or lint configuration. `npm run check` syntax-checks backend and frontend JavaScript. With no `TEST_MONGODB_URI`, integration suites explicitly skip rather than touching the application database. The test suite does NOT read application `.env` secrets. It uses synthetic local accounts and deletes those records afterwards. Never point it at production.

The migration removes only the obsolete conversation-wide idempotency index and the call-history TTL index, then creates current model indexes. It does not delete documents or run `syncIndexes()`. Back up before any database migration. Previously TTL-deleted calls cannot be recovered by this update. Old call records, messages without idempotency keys and existing user/post records remain readable. Old public image-message URLs remain readable for compatibility; newly uploaded conversation images use private storage. Historical public files are not automatically moved.

## Configuration

| Variable | Visibility | Purpose |
| --- | --- | --- |
| `PORT=4000` | Backend | HTTP listener |
| `NODE_ENV=production` | Backend | Production mode |
| `MONGODB_URI=mongodb://127.0.0.1:27017/picshare` | Secret | MongoDB connection |
| `JWT_SECRET=replace-with-at-least-32-random-characters` | Secret | Token signing; generate your own |
| `JWT_EXPIRES_IN=2h` | Backend | Session duration |
| `CLIENT_ORIGIN=https://photos.example.com` | Backend, public value | Comma-separated exact allowed browser origins; required in production |
| `GOOGLE_CLIENT_ID=example.apps.googleusercontent.com` | Public | Existing Google sign-in client |
| `MAX_UPLOAD_MB=5` | Backend | Image upload size |
| `UPLOAD_DIR=/var/lib/picshare/uploads` | Backend | Absolute durable media directory |
| `TURN_URL=turn:turn.example.com:3478,turns:turn.example.com:5349` | Backend, public URLs | coturn REST-compatible relay endpoints |
| `TURN_SHARED_SECRET=replace-with-server-only-coturn-secret` | Secret | HMAC secret shared with coturn; never sent to frontend |
| `AI_PROVIDER_URL=https://provider.example.com/photo-suggestions` | Backend | Optional adapter endpoint implementing the contract below |
| `AI_PROVIDER_KEY=replace-with-provider-token` | Secret | Optional provider authorization |
| `TEST_MONGODB_URI=mongodb://127.0.0.1:27017/picshare_test` | Test-only | Disposable integration database |

For a separate frontend host, set `window.PICSHARE_API_URL = 'https://api.example.com/api'` in a configuration script loaded before `js/api.js` in both HTML pages. Socket.IO uses the same derived origin. The same-origin Express deployment needs no frontend override.

`window.PICSHARE_MAP_TILES` can override the Leaflet tile template before `messages.js` loads. Development uses OpenStreetMap tiles with attribution. Configure a tile provider and its attribution/usage requirements for production, including the existing one-time map renderer. Do not assume public tiles offer unlimited production capacity. Opening maps or loading tiles shares map requests with that provider; no global PicShare coordinate broadcast exists.

### Optional AI provider contract

No paid provider is silently selected. Configure an HTTPS endpoint you operate or a provider gateway implementing this bounded JSON contract. This is a custom adapter contract, not a claim that an arbitrary vendor endpoint accepts this format.

Request: `POST`, bearer `AI_PROVIDER_KEY`, JSON:

```json
{"task":"photo_suggestions","image":{"mimeType":"image/png","base64":"IMAGE_BASE64"},"context":"User-provided context"}
```

Response (maximum 16 KiB):

```json
{"caption":"Suggested caption","hashtags":["#photography"],"altText":"A short factual image description"}
```

The backend truncates output, validates hashtags, limits context to 1,000 characters, enforces a 15-second provider timeout and deletes the temporary photo. Images are signature-checked and size-limited. The provider may charge and have its own data retention policy; choose/configure it before enabling this feature. No live external AI request was performed during verification.

## Production deployment

1. Use Node 22, MongoDB and one persistent Node process for this release. Install with `npm --prefix backend ci --omit=dev`; configure secrets outside Git and run `npm run migrate` before switching traffic.
2. Mount durable storage at `/var/lib/picshare`, set `UPLOAD_DIR=/var/lib/picshare/uploads`, and back up both MongoDB and the mounted directory. Public post/avatar files use `uploads`; private message images use the sibling `uploads-private` directory. Both must survive restarts. Never expose the private directory through a reverse proxy. Ephemeral-disk deployments are unsupported until an object-storage adapter is added.
3. Start with `npm start`. Terminate HTTPS at your hosting provider or reverse proxy, forwarding `/api`, `/uploads`, `/socket.io` and frontend requests to the same backend. Forward `Upgrade` and `Connection` headers for WebSockets; allow at least 75 seconds proxy idle timeout. Keep CORS origins explicit. If a proxy forwards client IPs, configure Express `trust proxy` to your exact trusted proxy topology before relying on per-client IP limits; never set an unrestricted trust policy blindly.
4. Configure coturn with `use-auth-secret` and the matching shared secret, TLS certificates, relay firewall ports and network permissions. `/api/auth/turn-credentials` requires login and returns one-hour HMAC credentials with `Cache-Control: no-store`. The shared secret stays backend-only. STUN-only calls can fail on restrictive networks.
5. Use a suitable production tile service; account for external fonts/Google/Leaflet CDN dependencies or self-host these assets under your deployment's policy. Configure the AI gateway only if desired.
6. Verify two real devices on separate networks. This update has not been deployed or verified against production infrastructure.

Single-instance operation is deliberate: presence maps, call invite reservations and timers are process-local. Before horizontal scaling, add Redis Socket.IO distribution, distributed call reservations and shared presence/deadline state, plus shared media storage and proxy affinity where polling is enabled. A Redis adapter alone does not solve distributed busy locks. Persistent MongoDB messages survive process restarts, but notifications/socket publication are not a transactional outbox; reconnect recovery restores message history after a missed publication. Inbox is currently capped at 50 conversations, and derived unread/latest queries favor correctness over large-account efficiency.

## Manual acceptance with two accounts

1. Start the application against a development database. Register Alice and Bob in separate browser profiles/devices. Log out/in and reload to verify sessions. Check profile edits, avatar upload, feed creation, likes and comments still work.
2. Open Bob's profile as Alice and choose Message, or search in Messages → New message. Verify one conversation is reused in either direction. Send text and a private image. Reload both sides; check history, latest preview, unread counts and acknowledgements. Images must not create feed posts.
3. Close Bob's tab, send more messages, reopen and confirm recovery. Disconnect/reconnect Alice's network and retry a failed send; the same retry key must produce one database message. Send more than 30 messages and load older history. Use Reply, Edit, reaction and Delete; verify Bob sees the changes.
4. Share a feed post with Bob by username. Confirm preview and link open the original photo, and deleted originals report unavailable.
5. Open a third account: direct REST reads, attachment URLs, socket joins, receipts, typing, calls and location session reads must reject unauthorized access (automated negative tests cover these paths).
6. With both users in Messages, start audio and video calls. Check accept, reject, caller cancel, no answer, busy, mute, camera toggle and hang-up. Deny microphone/camera permission and disconnect the network. Verify browser camera/microphone indicators turn off when ending. Keep this explicit: **actual WebRTC media on two real devices/separate networks remains a required manual acceptance check**; automated tests exercise signaling/state, not real media connectivity.
7. Share one-time location: check permission occurs only after the action, preview cancellation sends nothing and confirming creates a map. Start a 15-minute live session, view it as Bob, move and check updates, then stop. Bob must lose access immediately after successful revocation. Test permission denial, expiry and background/suspend behavior. Block either account and confirm live sharing is revoked and new messages/calls fail.
8. Enable browser notifications explicitly; close/deny the prompt and confirm the inbox still works. Without the Messages page running there is no service-worker push delivery.
9. With AI unconfigured, suggestions must show a useful error while manual publishing still works. With a configured gateway, consent to sending a non-sensitive test photo, review/edit suggestions and share manually. No automatic publishing occurs.

## Files and database changes

- Backend runtime/config: `backend/server.js`, `backend/middleware/auth.js`, `backend/utils/upload.js`, `backend/utils/contact.js`, `backend/socketHandler.js`, `backend/.env.example`, dependency manifests/lockfile.
- Models: `Conversation`, `Message`, `Call`, `LocationSession`, `Notification`, `Block`, `Attachment`; `Post` adds backward-compatible `altText`. Existing `User`, `Follow`, `Comment` records are retained.
- Routes: conversations, locations, notifications, AI, auth (TURN), users (blocks), posts (alt text and direct post retrieval).
- Frontend: `frontend/messages.html`, `frontend/js/messages.js`, `frontend/css/messages.css`, `frontend/js/api.js`, `frontend/js/app.js`, `frontend/index.html`; original visual identity preserved.
- Verification/migration: `backend/test/auth.test.js`, `backend/test/communications.test.js`, `backend/scripts/check.js`, `backend/scripts/migrate-communications.js`, root `package.json` and this document. Existing uncommitted messaging files were completed in place, not discarded.

## Remaining work and practical limits

- This is an implemented MVP subset, not completion of every roadmap item. Real-device voice/video and geolocation permission tests, live provider AI success/error tests, TURN relay connectivity and production deployment are outstanding.
- Semantic/vector photo discovery and dedicated caption/hashtag search UI are not implemented. AI requires a configured custom provider gateway; no vendor-specific adapter or provider account was provisioned.
- General document/file attachments, richer notification center, service-worker push, incoming-call ringtone, unread separator, avatar grouping and contextual shared-media panel remain follow-ups. Messages pages must be open for incoming call alerts. Calls produce persistent summaries; separate call-history REST browsing is not implemented.
- Edits/deletions/reactions use realtime updates while connected; forward reconnect fetching recovers new messages but does not resync changes to older loaded messages. Reload/open history to recover those changes. The sender can retry a failed message while the page remains open; no offline durable browser outbox exists.
- No cloud object-storage adapter or horizontal scaling support is included. Use a durable volume and one backend instance. Old public message attachments need an explicit migration if their confidentiality must be upgraded.
- Browser suspension/backgrounding may pause geolocation, call heartbeats and notifications. Stop Sharing always stops the local watcher; if offline, last coordinates remain visible to the authorized recipient until server revocation succeeds or expiry. No uninterrupted background tracking is promised.
- Expired live coordinates are removed on reads/periodic cleanup and documents via TTL; expiry authorization does not depend on TTL timing. Location messages store only the live session ID, never live coordinate history.
- HTTPS and WebRTC encrypted media transport do not constitute end-to-end encrypted application messaging. Server/database operators can read stored messages. No E2EE or call recording is implemented.
- If credential-like values in the former tracked example were real, rotate them and review Git history. This change replaces the example with placeholders and preserves your local `.env`.

## Verification results (24 October 2026)

- `npm run check`: 31 JavaScript files passed syntax verification.
- `TEST_MONGODB_URI=mongodb://127.0.0.1:27028/picshare_test npm test`: 30 tests passed, zero failures/skips, using an isolated local MongoDB instance and real HTTP/Socket.IO clients. Google ID token success cases use the existing provider mock. Call SDP tests validate signaling authorization/state only.
- `npm --prefix backend audit fix`: compatible dependency patch applied; npm reported zero known vulnerabilities.
- `git diff --check`: passed.
- Browser smoke test: login, user search, start DM, send text, reload and retrieve persisted text, mobile call buttons visible. Evidence: [messenger screenshot](messenger-preview.png). No camera/microphone/location permissions were exercised.
- Preview and tests used disposable databases, separate from the user's `.env` database. No deployment, push or production migration was performed.
