# Shelf — Personal Media Library Platform

A minimalist social platform for cataloguing Books, Films & TV, Music, and Games.
Each user can have exactly **one library per media type** (enforced both in the UI and at the database level).

---

## Project Structure

```
shelf-app/
├── index.html           ← Frontend (standalone React app, no build step needed)
└── backend/
    ├── server.js        ← Express API server
    ├── schema.sql       ← Supabase/PostgreSQL schema (run once)
    └── package.json
```

---

## Frontend

Open `index.html` directly in a browser — no build step required.
Uses React 18 via CDN + Babel standalone for JSX.

**For production:** Migrate to Vite + React for proper bundling:
```bash
npm create vite@latest shelf-frontend -- --template react
```

---

## Backend Setup

### 1. Supabase (Database)

1. Create a project at https://supabase.com
2. Go to SQL Editor → paste the entire contents of `backend/schema.sql` → Run
3. Copy your **Project URL** and **service_role key** from Settings → API

### 2. Environment Variables

Create `backend/.env`:
```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key
JWT_SECRET=a-long-random-secret-string
PORT=3001
```

### 3. Install & Run

```bash
cd backend
npm install
npm run dev        # development
npm start          # production
```

---

## API Reference

### Auth
| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/auth/register` | `{ username, email, password }` |
| POST | `/api/auth/login`    | `{ email, password }` → `{ user, token }` |

### Libraries
| Method | Route | Description |
|--------|-------|-------------|
| GET    | `/api/libraries`               | Get your libraries (auth required) |
| POST   | `/api/libraries`               | Create library `{ type }` — max 1 per type |
| DELETE | `/api/libraries/:id`           | Delete a library |
| GET    | `/api/users/:username/libraries` | Public profile libraries |

### Items
| Method | Route | Description |
|--------|-------|-------------|
| GET    | `/api/libraries/:id/items`           | List items (paginated) |
| POST   | `/api/libraries/:id/items`           | Add item |
| PATCH  | `/api/libraries/:id/items/:itemId`   | Update item |
| DELETE | `/api/libraries/:id/items/:itemId`   | Remove item |

### Social
| Method | Route | Description |
|--------|-------|-------------|
| POST   | `/api/users/:id/follow`   | Follow a user |
| DELETE | `/api/users/:id/follow`   | Unfollow |
| GET    | `/api/feed`               | Activity feed from followed users |
| GET    | `/api/search?q=&type=`    | Search users and items |

---

## Key Design Decisions

### 1 Library Per Type Per User
Enforced at **3 layers**:
- **UI**: already-created types are greyed out in the modal
- **API**: returns 409 if type already exists for user
- **Database**: `UNIQUE (user_id, type)` constraint on `libraries` table

### Scalability Notes
- All tables use UUID primary keys (safe for distributed systems)
- Row-Level Security (RLS) enabled on all tables
- Activity feed is a database view — swap for a materialised table + triggers at scale
- Add Redis caching for feed and search at 10k+ users
- Add CDN (Cloudflare R2 / S3) for cover image uploads

---

## Roadmap

- [ ] Cover image uploads (Supabase Storage)
- [ ] External metadata API (Open Library, TMDB, MusicBrainz, IGDB)
- [ ] Item ratings & reviews
- [ ] Social feed page
- [ ] Profile pages (`/u/:username`)
- [ ] Lists & shelves within a library
- [ ] Mobile app (React Native, shared API)
