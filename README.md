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

### 3. Last.fm Album Database (Recommended)

The album browsing feature uses Last.fm's API — returns albums sorted by real listener count (millions of users). Free API key, no quota issues.

1. Go to [last.fm/api/account/create](https://www.last.fm/api/account/create)
2. Create an API account (instant, free)
3. Copy your **API Key** into `.env` as `LASTFM_API_KEY`
4. Seed your database (one-time):

```bash
# Start your server
node server.js

# Seed ALL genres at once (runs in background, ~5 min)
curl -X POST http://localhost:3001/api/albums/seed-all -H "Content-Type: application/json" -d '{"pages":5}'

# Or seed individual genres with year data (slower but gets years):
curl -X POST http://localhost:3001/api/albums/seed -H "Content-Type: application/json" -d '{"genre":"rock","pages":5}'
curl -X POST http://localhost:3001/api/albums/seed -H "Content-Type: application/json" -d '{"genre":"hip-hop","pages":5}'
curl -X POST http://localhost:3001/api/albums/seed -H "Content-Type: application/json" -d '{"genre":"pop","pages":5}'
# ... repeat for: rnb, electronic, metal, jazz, country, indie, folk, punk, classical, blues, soul, reggae, latin

# Check stats:
curl http://localhost:3001/api/albums/stats
```

After seeding genres: **Last.fm is never called again** for genre browsing. 10 genres × 1000 albums = ~5MB total.

**Step 2 — Seed by Year (required for year dropdown):**

```bash
# Seeds 100 most-listened albums per year (1980–2025) with real play counts + genre tags
# Takes ~10 min. Run ONCE — data lives in Supabase forever.
curl -X POST http://localhost:3001/api/albums/seed-years -H "Content-Type: application/json" -d '{"from":1980,"to":2025,"limit":100}'

# PowerShell:
Invoke-RestMethod -Method Post -Uri "http://localhost:3001/api/albums/seed-years" -ContentType "application/json" -Body '{"from":1980,"to":2025,"limit":100}'
```

After seeding years: Pick "Hip Hop" + "2017" → DAMN., Flower Boy, 4:44 sorted by real listener count.

Without Last.fm, the app falls back to iTunes Search API (free, no auth, decent results).

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
