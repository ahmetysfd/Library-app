# Shelf — Database & backend setup

Follow these steps in order. Steps **you** must do in the browser are marked **(you)**.

---

## Step 1 — Create Supabase project **(you)**

1. Go to [supabase.com](https://supabase.com) and sign in.
2. **New project** → choose org, name, database password, region → Create.
3. Wait until the project is ready (~1–2 minutes).

---

## Step 2 — Run the database schema **(you)**

1. In Supabase: **SQL Editor** → **New query**.
2. Open the file `schema.sql` from this folder in a text editor.
3. **Copy the entire contents** and paste into the SQL editor.
4. Click **Run** (or Ctrl+Enter).

You should see **Success**. If you get errors about objects already existing, you may have run the script before; see troubleshooting below.

**What this creates**

| Object | Purpose |
|--------|---------|
| `users` | Accounts (username, email, password hash) |
| `libraries` | One shelf per type per user (films, books, music, games) |
| `library_items` | Items on each shelf |
| `friend_requests` | Friend invites |
| `follows` | Follows for activity |
| `item_likes` | Likes on items |
| Views | `user_friends`, `activity_feed`, `user_stats` |
| RLS | Row-level security (Express uses **service role**, which bypasses RLS for API calls) |

---

## Step 3 — API keys for the server **(you)**

1. Supabase: **Settings** → **API**.
2. Copy:
   - **Project URL** → `SUPABASE_URL` in `.env`
   - **service_role** key (secret) → `SUPABASE_SERVICE_KEY` in `.env`  
     ⚠️ Never expose `service_role` in frontend code or public repos.

3. Open `.env` in this project and set:

```env
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...   # service_role, not anon
JWT_SECRET=                     # run: openssl rand -hex 32  (or any 32+ char random string)
```

Optional (for search features on the server):

```env
TMDB_API_KEY=
IGDB_CLIENT_ID=
IGDB_ACCESS_TOKEN=
GOOGLE_CLIENT_ID=
```

---

## Step 4 — Install & start (already done once if you ran setup)

```bash
cd "Personal Lib App"
npm install
npm start
```

Server listens on **http://localhost:3001** (or `PORT` in `.env`).

---

## Step 5 — Frontend

- Serve `index.html` over HTTP (e.g. `npx serve .` or Python `python -m http.server 8000`).
- Point the app’s API base URL to `http://localhost:3001` if your `index.html` is configured for it.

---

## Troubleshooting

| Problem | What to do |
|---------|------------|
| `relation already exists` | Tables already created; only re-run missing parts or use a fresh project. |
| `policy already exists` | Schema was applied twice; policies need manual drops or a new project. |
| Server can’t connect | Check `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` (no quotes, no spaces). |
| Register/login fails | Confirm schema ran successfully and `users` table exists. |

---

## What was automated on your machine

- `npm install` (dependencies for `server.js`)
- `.env` created from `.env.example` if it didn’t exist (you still must fill Supabase + `JWT_SECRET`)
- `.gitignore` so `node_modules` and `.env` aren’t committed by mistake

You still must: **Supabase project → run `schema.sql` → fill `.env` → `npm start`**.
