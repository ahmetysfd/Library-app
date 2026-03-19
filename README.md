# Shelf — Personal Media Library

A dark, minimal personal library app for tracking films, books, music, and games. Built with React (CDN), Express, and Supabase (PostgreSQL).

**Full database + backend walkthrough:** see **[SETUP.md](./SETUP.md)** (step-by-step; includes what’s automated vs what you must do in Supabase).

---

## Quick Start (Frontend Only)

Just open `index.html` in a browser — it works standalone with localStorage and demo data. No server needed for basic usage.

```bash
# Or serve locally for API access:
npx serve .
```

---

## Full Setup (With Database & Server)

> **Detailed guide:** [SETUP.md](./SETUP.md)

### 1. Supabase **(you, in browser)**

1. Create a free project at [supabase.com](https://supabase.com)
2. **SQL Editor** → paste all of `schema.sql` → **Run**
3. **Settings → API** → copy **Project URL** and **service_role** key (keep secret)

### 2. Environment **(you)**

```bash
# Windows PowerShell (if .env missing):
Copy-Item .env.example .env
# macOS/Linux:
cp .env.example .env
```

Edit `.env`: set `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, and `JWT_SECRET` (e.g. `openssl rand -hex 32`).

### 3. Install & Run

```bash
npm install   # already done if you followed SETUP.md
npm start
# Server: http://localhost:3001
```

### 4. Open the App

With the server running (`npm start` or `npm run dev`), open **`http://localhost:3001/`** — the server serves `index.html` and the API on the same port.  
(JSON-only check: **`http://localhost:3001/api/health`**.)

Using `file://` on `index.html` still works but is limited; prefer **`http://localhost:3001/`** when the backend is on.

---

## API Keys (Optional)

| Service | For | Get key at |
|---------|-----|------------|
| TMDB | Film & TV search | [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api) |
| IGDB/Twitch | Game search | [dev.twitch.tv/console](https://dev.twitch.tv/console) |
| Google OAuth | Sign in with Google | [console.cloud.google.com](https://console.cloud.google.com/apis/credentials) |

Books (Open Library) and Music (MusicBrainz) require no keys.

---

## Features

- **4 library types**: Films & TV, Books, Music, Games
- **Auth**: Email/password registration & login, Google OAuth
- **Database**: Supabase PostgreSQL with Row-Level Security
- **Friends**: Search users by username, send/accept friend requests
- **Library pages**: Grid & list views, filter by status, sort by title/rating/date
- **Item statuses**: Collected, Watching/Reading/Playing, Wishlist
- **Activity feed**: See what friends are adding
- **Offline mode**: Works with localStorage when server is unavailable
- **Responsive**: Adapts from desktop to mobile

---

## Architecture

```
index.html          — Single-file React frontend (CDN, no build step)
server.js           — Express API server
schema.sql          — Supabase/PostgreSQL schema with RLS policies
package.json        — Node.js dependencies
.env.example        — Environment variable template
```

### Database Schema

- `users` — accounts with username, email, password hash
- `libraries` — one per type per user (films, books, music, games)
- `library_items` — media entries with status, rating, metadata (JSONB)
- `friend_requests` — bidirectional friendship (pending → accepted)
- `follows` — one-directional follow for activity feed
- `item_likes` — like system for friends' items
- Views: `user_friends`, `activity_feed`, `user_stats`

### API Endpoints

**Auth**: `POST /api/auth/register`, `/api/auth/login`, `/api/auth/google`, `GET /api/auth/me`

**Libraries**: `GET /api/libraries`, `POST /api/libraries`, `DELETE /api/libraries/:id`

**Items**: `GET /api/libraries/:id/items`, `POST /api/libraries/:id/items`, `PATCH /api/libraries/:lid/items/:iid`, `DELETE /api/libraries/:lid/items/:iid`

**Friends**: `POST /api/friends/request`, `POST /api/friends/accept/:id`, `POST /api/friends/reject/:id`, `DELETE /api/friends/:id`, `GET /api/friends`, `GET /api/friends/requests`

**Social**: `GET /api/users/:username`, `GET /api/users/search?q=`, `GET /api/feed`, `GET /api/search?q=`

**Media Search**: `GET /api/search/films?q=`, `/books?q=`, `/music?q=`, `/games?q=`

---

## Deploying

### Frontend
Host `index.html` anywhere: Vercel, Netlify, GitHub Pages, S3, etc.  
Update `API_BASE` in the script to point to your server URL.

### Backend
Deploy `server.js` to: Railway, Render, Fly.io, Heroku, etc.  
Set environment variables from `.env`.

### Database
Supabase handles hosting, backups, and scaling automatically.

---

## Scaling Notes

The schema is designed for scale from day one:

- **Indexes** on all foreign keys, frequently queried columns, and full-text search
- **Row-Level Security** policies ensure data isolation per user
- **JSONB metadata** column allows flexible per-item data without schema changes
- **Materialized views** for stats and activity feed
- **Pagination** on all list endpoints (cursor-based upgrade path available)
- **Supabase** auto-scales Postgres, with connection pooling via PgBouncer
