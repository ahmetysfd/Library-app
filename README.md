# Shelf — Personal Media Library

A dark, minimal personal library app for tracking films, books, music, and games. Built with React (CDN), Express, and Supabase (PostgreSQL).

---

## Quick Start (Frontend Only)

Just open `index.html` in a browser — it works standalone with localStorage and demo data. No server needed for basic usage.

```bash
# Or serve locally for API access:
npx serve .
```

---

## Full Setup (With Database & Server)

### 1. Supabase

1. Create a free project at [supabase.com](https://supabase.com)
2. Go to **SQL Editor** → paste the contents of `schema.sql` → Run
3. Copy your **Project URL** and **service_role key** from Settings → API

### 2. Environment

```bash
cp .env.example .env
# Edit .env with your Supabase URL, service key, and a JWT secret
```

### 3. Spotify Album Browse (Recommended)

The album browsing feature uses Spotify's Client Credentials flow — no user login, no extended quota needed.

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
2. Create an app (any name, any description)
3. Copy **Client ID** and **Client Secret** into your `.env`
4. Seed your database (one-time, takes ~30 seconds):

```bash
# Start your server first
node server.js

# Then seed each genre (run once — data lives in Supabase forever)
curl -X POST http://localhost:3001/api/albums/seed -H "Content-Type: application/json" -d '{"genre":"rock"}'
curl -X POST http://localhost:3001/api/albums/seed -H "Content-Type: application/json" -d '{"genre":"pop"}'
curl -X POST http://localhost:3001/api/albums/seed -H "Content-Type: application/json" -d '{"genre":"hip-hop"}'
curl -X POST http://localhost:3001/api/albums/seed -H "Content-Type: application/json" -d '{"genre":"electronic"}'
curl -X POST http://localhost:3001/api/albums/seed -H "Content-Type: application/json" -d '{"genre":"jazz"}'
# ... repeat for metal, folk, country, rnb, indie, punk, classical, reggae, blues, latin
```

After seeding: **Spotify is never called again.** All 50+ users read from your Supabase `cached_albums` table.

Without Spotify setup, the app falls back to iTunes Search API (free, no auth, works out of the box).

### 3. Install & Run

```bash
npm install
npm start
# Server runs on http://localhost:3001
```

### 4. Open the App

Open `index.html` in your browser. It connects to `localhost:3001` automatically.

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
