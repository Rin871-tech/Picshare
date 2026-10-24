# PicShare 3.0 implementation journal

Mobile work is deferred at the owner's request until the web upgrade is finished and deployed. No production backend exists yet. No production environment/database/infrastructure will be changed.

Architecture: vanilla HTML/CSS/JS, Express, MongoDB/Mongoose, bearer JWT, bcrypt, Google ID token verification, Socket.IO and WebRTC. Prior upgrade and uncommitted files are preserved. Baseline: 31 JS syntax checks passed; integration tests use isolated MongoDB on port 27028. No web bundler exists.

Dependency order: authorization/media privacy → social/discovery → challenges/collections → stories → private Circles/albums → creator/safety tools → integrated browser and regression tests → deployment guide. Native projects remain deferred.

Implementation checklist:
- [x] Privacy/contact policies and protected media
- [x] Post editing, bookmarks, discovery filters and explainable ranking
- [x] Daily Photo Quest submissions, deadlines and unique voting
- [x] Collections and creator metrics
- [x] Stories with backend expiry and audiences
- [x] Circle membership and private feed
- [x] Collaborative albums with revocable image access
- [x] Privacy/safety settings, reports and notifications
- [x] Messenger recovery, preferences and call history
- [x] Tests, browser verification and deployment handoff

## Implemented web MVP

- **Discover:** real caption/hashtag/description search, creator search, category and mood filters, recent public photography, bounded pagination, popular hashtags, curated public collections and related recent photos. Trending uses unique likes plus distinct commenters on seven-day posts, with recency as tie-breaker and a chronological fallback. No private messages or live coordinates influence ranking. The Home feed has explicit Recent and Following modes.
- **Social/creator tools:** caption editing, server-derived hashtags, private bookmarks, named public/private collections, up to three pinned owned posts, portfolio links/categories, participation counts and creator metrics derived from current likes, comments and follows. There are no fabricated views, reach, verification badges or historical engagement totals.
- **Photo Quest:** deterministic UTC daily prompts and a weekly prompt, persistent owned-photo submissions, archives, deadlines, leaderboard and one changeable vote per account per challenge. Self-votes are rejected. Voted-on entries cannot be replaced with another photo. Unique database indexes prevent duplicate entries/votes on concurrent retries.
- **Stories:** photo upload, text overlay, a small sticker selection, public/follower audiences, previous/next viewing, reactions, unique views, owner-only viewer lists, owner deletion and a reply link into the author's Messenger conversation. Reads and media requests enforce the 24-hour deadline. A periodic worker removes expired records/media; authorization never waits for cleanup. Stories are photos, not video clips, in this release.
- **Private Circles:** named/described communities, owner/moderator/contributor/viewer permissions, explicit username invitations, member revocation and leaving, private photo feeds, photo comments and a persistent text discussion with deduplication/history. Authorized users receive invalidation events and retrieve current data through authenticated APIs. Former members do not receive new discussion invalidations or media access.
- **Collaborative albums:** private spaces using the same membership and media authorization rather than a second sharing implementation. Contributors upload photos/captions; viewers read only; owners/moderators manage members/photos. Date-ordered memories, comments, revocation and deletion work. Private media lives outside public static storage.
- **Public photo map:** users explicitly enter a place while creating a post and opt into publication. Coordinates are rounded to 0.1 degrees before storage (roughly 11 km in latitude). Category/date filters and a maximum of 100 recent public markers keep queries bounded. Markers link to the original photos. This feature never queries private live-location sessions or requests device location.
- **Privacy/safety center:** account visibility, who may message/call, story audiences, browser alert preference, active live-sharing status/revocation, blocked accounts, user/post reports, personal report status and cancellable account deletion requests. `ADMIN_USER_IDS` enables a server-authorized report review queue and deletion-request list. Report status updates do not pretend to remove content or complete account deletion automatically.
- **Messenger reliability:** original messaging/call/location functionality retained; per-user conversation pin/mute settings, call history, text forwarding, unread separators, reconnect recovery of new messages plus refreshed loaded edits/deletions/reactions, stable out-of-order insertion and refreshed notification preferences. Authenticated sockets expire with their tokens. A connection to the main feed does not falsely make a user call-ready: recipients need Messages open for calls.
- **AI Studio:** existing backend adapter retained, with separate editable suggestion preview and explicit Apply. Optional categories/mood join caption/hashtags/alt text. Publishing is always manual. Missing providers, provider rate limits and oversized output use a fallback. Success/error tests use a synthetic provider; no live paid provider was configured or invoked.
- **Presentation:** original warm editorial identity retained; five primary destinations, mobile bottom navigation, safe-area insets, phone-friendly forms, keyboard controls, focus states, reduced-motion support, loading/empty/error states and responsive photo grids.

## Privacy and media semantics

Private account visibility is deliberately **owner-only**, not an unimplemented approval-based follower system. The setting states that clearly. Public profile names/avatars can still be used in user search and existing conversations; private posts disappear from other users' feeds/search/profile reads. Approved-follower access and close-friends audiences remain future work.

Post images now use scoped, one-hour media URLs issued to an authenticated viewer. These tokens cannot authenticate APIs or Socket.IO. Express rechecks the owner's current visibility and block relationship on every image request. Stories and space images additionally recheck expiry/membership; revoking membership invalidates existing scoped links. Anyone who obtains a still-valid scoped link has that temporary bearer capability until expiry/revocation; downloaded copies and screenshots cannot be recalled. Refresh the page to renew expired image URLs. Avatar thumbnails remain public identity information.

**Do not serve `/uploads` or `uploads-private` directly from Nginx/CDN/static hosting.** Direct file hosting would bypass the access checks. API responses transparently decorate existing stored paths; no user/post records are rewritten. Purge any old public CDN mirrors before relying on new privacy settings. Existing exported/downloaded copies cannot be retroactively protected.

Blocking applies to one-to-one interactions, public content filtering, owner-controlled space access, and blocked authors' shared-space photos/discussions. Media access checks enforce the same rules. Historical direct-message text remains available to participants. Setting who may call is separate from message policy. Server-side contact checks remain authoritative.

## Files and models

New persistence: `Bookmark`, `Collection`, `Challenge`, `Entry`, `Vote`, `Story`, `StoryView`, `Space`, `SpaceItem`, `SpaceComment`, `Report`, `DeletionRequest`. Existing `User`, `Post`, `Conversation` gain backward-compatible optional fields/defaults; existing message, call, location, block, attachment and notification models remain in use.

Main backend additions: `backend/routes/social.js`, `backend/routes/community.js`, `backend/utils/privacy.js`, `backend/utils/media.js`. Existing posts/users/conversations/AI/socket/auth/server files were extended. `backend/server.js` now exports the actual application/server so security tests exercise real middleware, CORS, media routes and error handling without launching production.

Main frontend additions: `frontend/js/features.js`, `frontend/css/features.css`, `frontend/js/config.js`. Both HTML pages and existing app/messages scripts were integrated. The frontend remains plain JavaScript and static assets. There is no framework rewrite or duplicated frontend bundle.

Verification: `backend/test/social.test.js`, original auth and communications suites, and the extended migration/check scripts. Screenshot evidence is in `docs/picshare3-preview.png`. The temporary responsive test harness was removed after checking it; no fake users/photos are shipped with the app. Browser smoke-test data exists only in a separate disposable preview database.

## Install, run and verify

```sh
# From repository root, with Node 22 and MongoDB available:
npm --prefix backend ci
# Fresh setup only: copy backend/.env.example to backend/.env and replace placeholders.
# Preserve your existing .env; this upgrade did not overwrite it.
npm run check
TEST_MONGODB_URI=mongodb://127.0.0.1:27017/picshare_test npm test
npm start
# Optional development watcher:
npm run dev
```

Open `http://localhost:4000`. There is no frontend build step, linter or TypeScript compiler. `npm run check` parses all JavaScript. Without `TEST_MONGODB_URI`, integration suites explicitly report skipped tests. The full suite requires a **disposable database**, never production. Tests create their own synthetic accounts and clean them up. OAuth success and AI provider tests use mocks; they are not claims of live provider verification.

## Deployment handoff — owner action

No deployed API exists yet, and none was invented. No deployment, push, production migration, secret rotation or production data modification was performed. Use a staging deployment first.

1. Choose a Node hosting service that supports a persistent mounted disk and WebSocket upgrades. Deploy the repository as one Express service. Install command: `npm --prefix backend ci --omit=dev`. Start command: `npm start`. Health endpoint: `/api/health`. No frontend build command is required.
2. Configure environment variables below with your own values. Never put backend secrets in `frontend/js/config.js`. Set `NODE_ENV=production` and `CLIENT_ORIGIN` to the exact HTTPS site origin. Same-origin hosting requires no API override. If you later host the frontend separately, set the public `PICSHARE_API_URL` in `frontend/js/config.js` to the actual HTTPS API URL ending in `/api`.
3. Mount a durable volume at `/var/lib/picshare`; use `UPLOAD_DIR=/var/lib/picshare/uploads`. Express uses `uploads` for posts/avatars and the sibling `uploads-private` for message images, stories and shared-space photos. Both directories must survive redeployments and be backed up. Ephemeral disk hosting is unsupported. No cloud object-storage adapter is included.
4. Create MongoDB Atlas or another supported MongoDB deployment and apply least-privilege database access/network rules. Before importing an existing database or running index migration, take and verify a database backup and a matching media-directory backup. Run `npm run migrate` in **staging first**. The migration creates required indexes and removes obsolete communications indexes; it does not delete user/post data or run `syncIndexes()`.
5. Forward frontend, `/api`, `/uploads` and `/socket.io` to Express. Preserve WebSocket Upgrade/Connection headers and allow at least 75 seconds proxy idle timeout. If your host uses a reverse proxy, set `TRUST_PROXY` only to its verified hop count; leave it unset for a directly exposed Node server. Never broadly trust arbitrary forwarded headers or open CORS to all origins.
6. Configure your Google web OAuth client for the actual HTTPS origin; keep backend audience verification. Configure a coturn REST-compatible relay with the same shared secret as the backend, relay ports/firewall and TLS. Test audio/video between two real devices on different networks. STUN-only connectivity is insufficient for some networks.
7. Select a production-appropriate map tile provider. `frontend/js/config.js` controls public tile template and attribution for both the photo map and conversation maps. Development uses OpenStreetMap tiles; unlimited production capacity is not assumed. Map services receive tile requests; an external map link intentionally sends the selected place to the chosen map application.
8. Configure the optional HTTPS AI gateway only if desired. Its JSON contract remains documented in `docs/UPGRADE.md`, now with optional `categories` and `mood`. You must choose the provider, credentials, pricing and retention policy; no paid service is silently selected.
9. Verify the manual acceptance scenarios below, then deploy the same tested release. Once your HTTPS endpoint is healthy, send it back here for the deferred Capacitor conversion.

### Environment reference (placeholders only)

| Variable | Purpose / visibility |
| --- | --- |
| `PORT=4000` | Backend listener; host may provide it |
| `NODE_ENV=production` | Backend production mode |
| `MONGODB_URI=mongodb://HOST/picshare` | **Secret** database connection; use your real staging/production database |
| `JWT_SECRET=REPLACE_WITH_32_OR_MORE_RANDOM_CHARACTERS` | **Secret** signing key; preserve an existing deployment's value unless intentionally rotating |
| `JWT_EXPIRES_IN=2h` | Token lifetime |
| `CLIENT_ORIGIN=https://YOUR_SITE_HOST` | Exact allowed browser origins, comma-separated |
| `TRUST_PROXY=` | Optional verified integer proxy hop count, 0–5 |
| `GOOGLE_CLIENT_ID=YOUR_WEB_CLIENT_ID` | Public OAuth client ID, verified by backend |
| `MAX_UPLOAD_MB=5` | Image limit |
| `UPLOAD_DIR=/var/lib/picshare/uploads` | Durable filesystem path |
| `TURN_URL=turns:YOUR_TURN_HOST:5349` | Relay URL; public endpoint |
| `TURN_SHARED_SECRET=YOUR_COTURN_SHARED_SECRET` | **Secret**, never bundled in frontend |
| `AI_PROVIDER_URL=https://YOUR_GATEWAY/photo-suggestions` | Optional gateway implementing documented contract |
| `AI_PROVIDER_KEY=YOUR_PROVIDER_TOKEN` | **Secret**, backend only |
| `ADMIN_USER_IDS=YOUR_EXISTING_ADMIN_OBJECT_ID` | Optional explicit report-review allowlist, comma-separated |
| `TEST_MONGODB_URI=mongodb://127.0.0.1:27017/picshare_test` | Disposable test DB only |

The actual local `.env` remains unchanged. `backend/.env.example` contains placeholders, not working credentials. Root Capacitor dependencies were removed after mobile work was deferred; there are no native projects, APKs, archives, signing secrets or mobile deployment claims in this change.

### Backup and rollback

Keep a verified MongoDB snapshot and synchronized `uploads`/`uploads-private` backup before upgrading. Old records remain compatible; new fields are optional. Older posts remain searchable by captions even when their new category/tag fields are empty. Restoring a previous application release may remove privacy enforcement for newly private content, so rollback must keep media private and restore an appropriate database/media snapshot to a new, isolated environment before changing traffic. Pause writes during a restore; do not run destructive cleanup against the live database. No rollback command was run here.

Single backend instance only: Socket.IO presence, call invite reservations and timers are process-local. Horizontal scaling requires a shared event adapter, distributed call reservations/presence, and shared media storage. Media publication/notifications are not a transactional outbox; REST recovery remains the source of durable message history. Bounded limits include 50 inbox conversations, 30 space/photos or discussion messages per page, 60 active stories, 100 collection photos/space comments, 50 space members, 100 map markers and up to 500 owned posts in creator metrics. Advanced high-volume query/index tuning is future work.

## Manual acceptance checklist

Use Alice, Bob and an unrelated third account in separate browser profiles against staging:

1. Register/log in, restore sessions, edit profiles/portfolio, upload an avatar and photo, edit caption, like/comment/follow, bookmark and reload. Confirm existing accounts/posts remain intact.
2. Discover a caption/hashtag, filter category/mood, switch Recent/Trending and load another page. Create public/private collections, add a photo, verify the third account cannot access private collections. Pin an owned post; another user cannot pin it for you.
3. Submit an owned public photo to a daily/weekly quest, vote from another account, retry the vote, verify uniqueness and reject submissions/votes after closing. Private posts cannot become public challenge entries through a bypass.
4. Create a follower-only Story, check an unrelated account is denied, follow with Bob, verify sequential viewing/reactions, owner-only viewer list, deletion and backend expiry/media cleanup.
5. Create a Circle and album. Invite Bob as viewer, test upload denial, change to contributor, upload/comment/discuss, then remove Bob. Reuse the old image URL after removal: access must fail. Try a third account against every private endpoint. Repeated discussion sends with the same retry key must persist once.
6. Set an account private: another account must lose profile/post/search/media access, including previously issued scoped links. Test message/call policies and blocking. Stop live sharing through Privacy & safety and verify recipient access ends. Previously downloaded copies cannot be revoked.
7. Create a post with explicit approximate place and inspect its rounded map marker; verify ordinary posts and private live sessions do not appear. Change category/date filters. No automatic geolocation prompt should occur on this map.
8. Verify DM persistence, images, replies, edits, reactions, forwarding, pin/mute, read/unread, call history and reconnect recovery. Open Messages on both devices before calling. Test permission denial, accept/reject/cancel/busy/no-answer/mute/camera/hang-up, TURN connectivity and resource cleanup. **Actual two-device media and background behavior remain manual acceptance requirements.**
9. Try AI without configuration, then with your gateway: consent to photo transmission, review/edit/apply suggestions, manually publish. Verify timeouts/rate limits are recoverable. Provider tests here are mocks, not a live paid-service test.
10. Submit a user/post report, inspect your own report status, configure a real admin ID and review the queue. Request/cancel account deletion; verify submitting a request does not falsely claim erasure.

## Remaining scope and unverified behavior

This release implements the web MVP slices above, not every advanced item in the broad roadmap. Remaining work includes semantic embeddings/vector search, a personalized recommendation model (Recent/Following are the truthful current modes), video Stories/close-friends audiences, follower-approval private profiles, join requests and invite acceptance, space/profile cover uploads, custom themed challenge administration, stronger anti-abuse identity controls, historical view/follower-growth tracking, photo-map proximity search, moderator comment editing/removal, automatic account/data erasure under an owner-defined policy, service-worker/native push, voice notes and group calls.

Public report review records status; content removal outside Circle/album moderation still uses the existing owner tools. There is no automatic global moderation or identity verification claim. A one-account-per-challenge vote constraint is not Sybil/bot detection. Public profiles expose names/avatars for navigation; private-post enforcement does not make downloaded files recoverable.

Circle discussion is a basic persistent text thread, not a full group version of Messenger. Stories link replies into DMs; there is no retained expired-story preview in the message. A removed collaborator's existing contributions remain with the shared space until authorized removal. Members should understand that shared photos may be downloaded by other members.

Browser suspension can interrupt calls, location updates and notifications. Calls require Messages open; no background/terminated-app calls are claimed. HTTPS/WebRTC media encryption is not full end-to-end encrypted application messaging. TURN, real Google OAuth origin setup, real AI responses, production tile usage and production hosting have not been verified here. No mobile simulator or physical-device test was performed; native conversion remains explicitly deferred until deployment.

## Verification results — 24 October 2026

- Baseline before new features: original syntax checks passed and the original 30 integration tests passed against isolated MongoDB.
- Final suite: **47 tests passed, zero failures/skips**, against `picshare_test` on a separately started local MongoDB instance. Coverage includes existing social/auth/communications behavior, privacy/media authorization, expired tokens, call policy, Stories expiry, vote uniqueness/deadlines, Circle/album roles and revocation, discussion deduplication, scoped-token restrictions, reports, approximate maps, bookmarks/collections, and mocked AI success/failure/output bounds.
- `npm run check`: **50 JavaScript files** parsed successfully.
- `git diff --check`: passed.
- `npm --prefix backend audit --omit=dev`: **zero known production dependency vulnerabilities** reported. No new web runtime dependency was needed for the 3.0 slices.
- Browser smoke checks: existing preview account login/session, Discover navigation, private Circle creation, persisted member invitation, Circle discussion send/display, settings save/refetch, and daily/weekly challenge screens. A temporary 390px iframe harness verified phone-sized Discover and the five-destination mobile navigation; this was a responsive website check, not a mobile app/device test. The harness was removed afterward.
- Browser evidence: [PicShare 3.0 preview](picshare3-preview.png). Preview records are separate from the application database; they are not production seed data.
- No actual microphone/camera/geolocation permissions, two-device media, live paid AI provider, production TURN server, public deployment or native build was tested. Those limitations are explicit above.

Before migration, resolve any duplicate records that prevent a new unique index from being created; the migration stops on errors rather than deleting data to force success. All changes remain local/uncommitted alongside the pre-existing work; no push or production action occurred.
