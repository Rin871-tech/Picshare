# PicShare — Mini Social Media App

An Instagram-inspired, responsive mini social network built with **HTML, CSS, vanilla JavaScript, Express.js, and MongoDB/Mongoose**.

## Features

- Register and log in with email/password
- Google Sign-In and Sign-Up via Google Identity Services and secure backend token verification
- Password hashing using bcrypt
- JWT-protected API routes
- Edit profile name, username, bio, and avatar
- Create image posts with captions
- For-you feed and feed limited to followed accounts
- Like/unlike posts
- Add comments; authors can delete their comments, and post owners can moderate comments on their posts
- Follow/unfollow people
- Search for users and view profiles/statistics
- Responsive desktop and mobile layout
- Image MIME-type allowlist and upload-size limit
- Helmet security headers, request rate limiting on authentication endpoints, JSON body limits, and environment-based configuration

## Requirements

- Node.js 18 or newer (Node 20 LTS recommended)
- npm
- MongoDB locally, or a MongoDB Atlas connection string
- (Optional) Google Cloud OAuth Client ID for Google Sign-In

## 1. Configure the backend

From the project root:

```bash
cd backend
npm install
cp .env.example .env
```

Edit `backend/.env` and set a strong random `JWT_SECRET` (at least 32 characters), your database connection string, and your Google Client ID:

Example configuration:

```env
PORT=4000
NODE_ENV=development
MONGODB_URI=mongodb://127.0.0.1:27017/picshare
JWT_SECRET=replace-this-with-a-long-random-secret-at-least-32-characters
JWT_EXPIRES_IN=2h
CLIENT_ORIGIN=http://localhost:5500,http://127.0.0.1:5500,http://localhost:4000,http://127.0.0.1:4000
MAX_UPLOAD_MB=5
GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
```

For MongoDB Atlas, replace `MONGODB_URI` with your Atlas connection string. URL-encode special characters in the database username/password, allow your development IP in Atlas Network Access, and never commit the connection string.

## 2. Google Cloud Console Setup (for Google Sign-In)

To enable "Continue with Google":

1. Visit the [Google Cloud Console](https://console.cloud.google.com/).
2. Select an existing project or create a new project.
3. In the left navigation, go to **APIs & Services** > **OAuth consent screen**:
   - Choose User Type **External** and click **Create**.
   - Provide an **App name** (e.g., `PicShare`), **User support email**, and **Developer contact email**.
   - Save and continue through the remaining steps.
4. Go to **APIs & Services** > **Credentials**:
   - Click **Create Credentials** > **OAuth client ID**.
   - Select **Web application** as the Application type.
   - Set **Name** to `PicShare Web Client`.
   - Under **Authorized JavaScript origins**, add:
     - `http://localhost:4000`
     - `http://127.0.0.1:4000`
     - `http://localhost:5500` (if using VS Code Live Server)
     - `http://127.0.0.1:5500`
   - Click **Create**.
5. Copy the generated **Client ID** (it ends with `.apps.googleusercontent.com`).
6. Paste it into your `backend/.env` file:
   ```env
   GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
   ```
7. Restart the backend server if running.

## 3. Start the app

Ensure MongoDB is running, then from the root directory or `backend/`:

```bash
npm run dev
```

Or from `backend/`:

```bash
npm run dev
```

Open **http://localhost:4000**. Express serves both the frontend and API, so a separate frontend server is not required.

If you prefer VS Code Live Server, start it on port 5500 and keep `CLIENT_ORIGIN` configured for that origin. The frontend API client targets `http://localhost:4000/api` automatically.

Health check: http://localhost:4000/api/health

## 4. Running automated tests

Run the comprehensive test suite (testing valid registration, invalid input validation, duplicate username/email 409 errors, local login, and Google OAuth flows):

```bash
npm test
```

Or from `backend/`:

```bash
npm test
```

## Project structure

```text
picshare/
├── frontend/
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── api.js
│       └── app.js
├── backend/
│   ├── server.js
│   ├── .env.example
│   ├── middleware/auth.js
│   ├── models/{User,Post,Comment,Follow}.js
│   ├── routes/{auth,users,posts}.js
│   ├── test/auth.test.js
│   ├── utils/{asyncHandler,upload}.js
│   └── uploads/                 # Local development uploads; not committed
├── package.json
└── README.md
```

## API overview

All routes are prefixed with `/api`. Protected endpoints require `Authorization: Bearer <token>`.

| Method | Route | Description |
|---|---|---|
| GET | `/auth/config` | Public auth configuration (`googleClientId`) |
| POST | `/auth/register` | Create account with email & password |
| POST | `/auth/login` | Authenticate with email & password |
| POST | `/auth/google` | Verify Google ID token and log in / sign up |
| GET | `/users/me` | Current user and stats |
| PATCH | `/users/me` | Update profile / change password |
| POST | `/users/me/avatar` | Upload profile image (`multipart/form-data`, field `image`) |
| GET | `/users/search?q=...` | Search accounts |
| GET | `/users/:id` | Public profile, stats, and posts |
| POST | `/users/:id/follow` | Toggle follow state |
| GET | `/posts/feed?mode=all&page=1&limit=12` | Chronological feed |
| GET | `/posts/feed?mode=following` | Followed users plus your own posts |
| POST | `/posts` | Create post (`multipart/form-data`, fields `image`, `caption`) |
| DELETE | `/posts/:id` | Delete your own post |
| POST | `/posts/:id/like` | Toggle like |
| GET | `/posts/:id/comments` | List comments |
| POST | `/posts/:id/comments` | Add comment (`{ "text": "..." }`) |
| DELETE | `/posts/:postId/comments/:commentId` | Delete own comment or moderate own post |

## Data model

- **User:** username, name, email, password hash, bio, avatar URL
- **Post:** author, caption, image URL, likes, timestamps
- **Comment:** post, author, text, timestamps
- **Follow:** follower, following, timestamps; unique compound index prevents duplicate follows

Mongoose creates collections and indexes when the app starts and models are used.

## Security notes

- Passwords are hashed with bcrypt; plaintext passwords are never stored.
- Never put `.env` in source control. Rotate any secret that is accidentally exposed.
- The browser stores the short-lived JWT in `localStorage` for this demo. This is simple for a learning project but vulnerable if an XSS bug is introduced. For production, consider an `HttpOnly`, `Secure`, `SameSite` cookie-based session/token design with CSRF protection where applicable.
- Uploaded images are limited by size and MIME type, stored with random names, and never use the original client filename. MIME checks alone are not full file-content verification; production should inspect file signatures and use managed object storage/CDN.
- Local `backend/uploads` storage is suitable for development only. Use S3/Cloudinary or another managed object store for deployment; local files may be ephemeral on hosting platforms.
- Add email verification, password reset, account deletion, moderation/reporting, pagination limits, and automated tests before public launch.
- Configure `CLIENT_ORIGIN` to the exact frontend origin(s) in production. Do not use wildcard origins with credentials.

## Deployment outline

1. Create a MongoDB Atlas database and configure network access securely.
2. Deploy the Express backend to a Node-compatible host; set `MONGODB_URI`, `JWT_SECRET`, `NODE_ENV=production`, and `CLIENT_ORIGIN` as environment variables.
3. For image persistence, integrate Cloudinary/S3 rather than local `uploads` storage.
4. Deploy the `frontend` directory to a static host if desired and set `window.PICSHARE_API_URL` before `js/api.js` loads to the deployed API URL plus `/api`; alternatively serve the frontend from the same Express service as this project does by default.
5. Use HTTPS, a strong secret, monitoring, and a production database user with least-privilege access.

## Notes

This is a complete educational MVP, not a production-hardened social network. It intentionally does not include stories, DMs, notifications, or video uploads. The “story” row is a discovery shortcut, not a real ephemeral story feature.
