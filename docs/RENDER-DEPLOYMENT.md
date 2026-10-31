# Render + MongoDB Atlas deployment

## Existing service

- Dashboard: https://dashboard.render.com/web/srv-dbed5edg1s2s73f7mft0
- Assigned URL: https://picshare-5qf9.onrender.com (API health and login page verified October 30, 2026)
- Repository: `Rin871-tech/Picshare`, branch `main`
- Build command: `npm --prefix backend ci --omit=dev`
- Start command: `npm start`
- Health check: `/api/health`
- Keep one instance: messaging presence and call reservations currently use process memory.

## Deployment status

Deployment `dep-dbi3qeqfngtc73c7dpog` of `c879e9e` is Live. The public
`/api/health` responds with status `ok`, and the HTTPS login page loads.
Authenticated uploads, messaging, and calls still require an end-to-end smoke test.

## Resolved configuration failures

After the connection string update on October 30, deployment
`dep-dbi3ngmi0phs73cp6jq0` reaches MongoDB but fails with code 8000:
`bad auth : authentication failed`. Verify the Atlas database user's username
and password in Render's `MONGODB_URI`; Atlas account credentials are different
from database-user credentials. Preserve the driver URI's authentication options
and URL-encode reserved characters in credential components exactly once.

Earlier failure:

The latest deployment of `c879e9e` built successfully but failed at startup with
`querySrv ENOTFOUND _mongodb._tcp.23`. The configured connection string resolves
to an invalid Atlas hostname. Correct `MONGODB_URI` in the service's Environment
page using Atlas → Connect → Drivers. Do not commit credentials or paste them
into chat. URL-encode reserved characters in the username/password components
only; preserve the Atlas hostname and URI separators.

Atlas must allow the Render service's outbound IP ranges, and its database user
must have access to the intended PicShare database. Do not broaden network access
to all IP addresses as a default. Do not run data migrations against the existing
database until its contents and backup have been verified.

## Runtime settings

- `NODE_ENV=production`
- `CLIENT_ORIGIN=https://picshare-5qf9.onrender.com` (exact origin, no trailing slash)
- `JWT_SECRET`: retain the configured secret, at least 32 characters.
- `MONGODB_URI`: secret Atlas driver URI with the intended database name.
- `PORT`: use Render's injected value.
- `GOOGLE_CLIENT_ID`: if Google login is enabled, authorize this exact HTTPS
  origin in the corresponding Google OAuth application.
- `TRUST_PROXY`: configure only after verifying Render's proxy hop count.
- TURN and AI provider settings require real providers for those features.

## Persistent uploads

The user selected the free plan for a temporary demo on October 30, 2026.
Do not upgrade or provision a paid disk for this demo. Uploaded files on the
free instance are temporary and can disappear after a restart or redeploy.

Free Render compute does not support persistent disks. Before accepting durable
photo uploads, upgrade the existing service to an approved paid compute plan and
attach a disk mounted at `/var/data/picshare`. Set
`UPLOAD_DIR=/var/data/picshare/uploads`. Mount the parent directory because private
attachments are stored in the sibling `uploads-private` directory.

Changing this path does not transfer old photos. Verify whether existing Atlas
records reference media that needs copying before changing storage. Preserve
authenticated media routes; do not expose the disk as a public static directory.

## Release verification

After correcting configuration, deploy the latest commit and confirm:

1. Render logs show the database connected and the service listening.
2. `/api/health` returns HTTP 200 and the frontend loads over HTTPS.
3. Sign-up/login, authorized photo upload and retrieval, and messaging work.
4. Uploaded photos survive a service restart with the persistent disk attached.
5. Two authenticated clients exchange messages and receipts over Socket.IO.

Local JavaScript syntax checks passed for 50 files on October 30, 2026. This does
not verify Atlas connectivity or production behavior.

References: [Render disks](https://render.com/docs/disks),
[Atlas driver connections](https://www.mongodb.com/docs/atlas/driver-connection/).
