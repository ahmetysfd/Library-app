/**
 * SHELF — Backend API + Metadata Proxy Server (v2)
 * Stack: Node.js + Express + Supabase
 *
 * Setup:
 *   1. Create a Supabase project at https://supabase.com
 *   2. Run schema.sql in the SQL editor
 *   3. Copy your project URL and service key
 *   4. Create .env file (see below)
 *   5. npm install && node server.js
 *
 * .env file:
 *   SUPABASE_URL=https://your-project.supabase.co
 *   SUPABASE_SERVICE_KEY=your-service-role-key
 *   JWT_SECRET=your-random-secret-string-at-least-32-chars
 *   TMDB_API_KEY=your-tmdb-key
 *   IGDB_CLIENT_ID=your-twitch-client-id
 *   IGDB_ACCESS_TOKEN=your-twitch-access-token
 *   GOOGLE_CLIENT_ID=your-google-oauth-client-id
 *   PORT=3001
 */

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');
const jwt    = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');
const path = require('path');

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));

// Chrome DevTools probes this endpoint; return 200 to avoid noisy 404s.
app.get('/.well-known/appspecific/com.chrome.devtools.json', (_req, res) => {
  res.type('application/json').send('{}');
});
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ── Supabase client ─────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || 'placeholder'
);

// ── Google OAuth ────────────────────────────────────────────────────────────
const googleClient = process.env.GOOGLE_CLIENT_ID 
  ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID) 
  : null;

// ── JWT Auth Middleware ─────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, email: user.email },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

const auth = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// Optional auth — sets req.user if token present, continues regardless
const optAuth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (token) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch {}
  }
  next();
};


// ════════════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ════════════════════════════════════════════════════════════════════════════

// Register with username + email + password
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || username.length < 2) return res.status(400).json({ error: 'Username must be at least 2 characters' });
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
    if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const hash = await bcrypt.hash(password, 12);
    const { data, error } = await supabase
      .from('users')
      .insert({ username: username.toLowerCase().trim(), email: email.toLowerCase().trim(), password_hash: hash })
      .select('id,username,email,display_name,avatar_url')
      .single();

    if (error) {
      if (error.message.includes('duplicate')) {
        if (error.message.includes('username')) return res.status(409).json({ error: 'Username already taken' });
        if (error.message.includes('email')) return res.status(409).json({ error: 'Email already registered' });
      }
      return res.status(400).json({ error: error.message });
    }

    res.status(201).json({ user: data, token: signToken(data) });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Login with email + password
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email.toLowerCase().trim())
      .single();

    if (!user || error) return res.status(401).json({ error: 'Invalid email or password' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    const { password_hash, ...safe } = user;
    res.json({ user: safe, token: signToken(safe) });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Google OAuth sign-in
app.post('/api/auth/google', async (req, res) => {
  try {
    const { credential } = req.body; // Google ID token
    if (!googleClient) return res.status(503).json({ error: 'Google auth not configured' });

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const { sub: googleId, email, name, picture } = payload;

    // Check if user exists
    let { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (!user) {
      // Create new user
      const username = email.split('@')[0].replace(/[^a-z0-9_]/gi, '_').toLowerCase().slice(0, 25);
      const { data: newUser, error } = await supabase
        .from('users')
        .insert({
          username,
          email,
          password_hash: 'google-oauth-' + googleId, // Not a real hash — Google users don't use passwords
          display_name: name,
          avatar_url: picture,
        })
        .select('id,username,email,display_name,avatar_url')
        .single();

      if (error) return res.status(400).json({ error: error.message });
      user = newUser;
    }

    const { password_hash, ...safe } = user;
    res.json({ user: safe, token: signToken(safe) });
  } catch (e) {
    res.status(401).json({ error: 'Google authentication failed' });
  }
});

// Get current user profile
app.get('/api/auth/me', auth, async (req, res) => {
  const { data: user } = await supabase
    .from('users')
    .select('id,username,email,display_name,avatar_url,bio,created_at')
    .eq('id', req.user.id)
    .single();
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});


// ════════════════════════════════════════════════════════════════════════════
// LIBRARIES
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/libraries', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('libraries')
    .select('*, items:library_items(count)')
    .eq('user_id', req.user.id)
    .order('created_at');
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.post('/api/libraries', auth, async (req, res) => {
  const { type } = req.body;
  if (!['books','films','music','games'].includes(type))
    return res.status(400).json({ error: 'Invalid library type' });

  const { data: existing } = await supabase
    .from('libraries')
    .select('id')
    .eq('user_id', req.user.id)
    .eq('type', type)
    .single();
  if (existing) return res.status(409).json({ error: `You already have a ${type} library` });

  const { data, error } = await supabase
    .from('libraries')
    .insert({ user_id: req.user.id, type })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

app.delete('/api/libraries/:id', auth, async (req, res) => {
  const { error } = await supabase
    .from('libraries')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});


// ════════════════════════════════════════════════════════════════════════════
// LIBRARY ITEMS
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/libraries/:id/items', auth, async (req, res) => {
  const { page = 1, limit = 50, status, sort = 'created_at' } = req.query;
  const from = (page - 1) * limit;

  let query = supabase
    .from('library_items')
    .select('*', { count: 'exact' })
    .eq('library_id', req.params.id);

  if (status && status !== 'all') query = query.eq('status', status);

  const sortMap = {
    'created_at': ['created_at', { ascending: false }],
    'title': ['title', { ascending: true }],
    'rating': ['rating', { ascending: false }],
  };
  const [col, opts] = sortMap[sort] || sortMap['created_at'];
  query = query.order(col, opts);

  const { data, count, error } = await query.range(from, from + Number(limit) - 1);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ items: data, total: count, page: Number(page), pages: Math.ceil(count / limit) });
});

app.post('/api/libraries/:id/items', auth, async (req, res) => {
  // Verify ownership
  const { data: lib } = await supabase.from('libraries').select('user_id').eq('id', req.params.id).single();
  if (!lib || lib.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  const { ext_id, title, subtitle, cover_url, status, metadata, rating, notes } = req.body;
  const { data, error } = await supabase
    .from('library_items')
    .insert({ library_id: req.params.id, ext_id, title, subtitle, cover_url, status: status || 'collected', metadata: metadata || {}, rating, notes })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

app.patch('/api/libraries/:lid/items/:iid', auth, async (req, res) => {
  const { data: lib } = await supabase.from('libraries').select('user_id').eq('id', req.params.lid).single();
  if (!lib || lib.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  const allowed = ['status', 'rating', 'notes', 'metadata'];
  const updates = {};
  for (const key of allowed) if (req.body[key] !== undefined) updates[key] = req.body[key];

  const { data, error } = await supabase
    .from('library_items')
    .update(updates)
    .eq('id', req.params.iid)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.delete('/api/libraries/:lid/items/:iid', auth, async (req, res) => {
  const { data: lib } = await supabase.from('libraries').select('user_id').eq('id', req.params.lid).single();
  if (!lib || lib.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  await supabase.from('library_items').delete().eq('id', req.params.iid);
  res.json({ success: true });
});


// ════════════════════════════════════════════════════════════════════════════
// FRIENDS SYSTEM
// ════════════════════════════════════════════════════════════════════════════

// Search users by username
app.get('/api/users/search', optAuth, async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json([]);

  const { data } = await supabase
    .from('users')
    .select('id,username,display_name,avatar_url')
    .ilike('username', `%${q}%`)
    .neq('id', req.user?.id || '')
    .limit(10);
  res.json(data || []);
});

// Send friend request
app.post('/api/friends/request', auth, async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });

  const { data: target } = await supabase
    .from('users')
    .select('id,username')
    .eq('username', username.toLowerCase().trim())
    .single();
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'Cannot friend yourself' });

  // Check if already friends or request pending
  const { data: existing } = await supabase
    .from('friend_requests')
    .select('id,status')
    .or(`and(sender_id.eq.${req.user.id},receiver_id.eq.${target.id}),and(sender_id.eq.${target.id},receiver_id.eq.${req.user.id})`)
    .single();

  if (existing) {
    if (existing.status === 'accepted') return res.status(409).json({ error: 'Already friends' });
    if (existing.status === 'pending') return res.status(409).json({ error: 'Request already pending' });
  }

  const { data, error } = await supabase
    .from('friend_requests')
    .insert({ sender_id: req.user.id, receiver_id: target.id })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });

  // Auto-follow as well
  await supabase.from('follows').upsert({ follower_id: req.user.id, following_id: target.id });

  res.status(201).json({ request: data, target });
});

// Accept friend request
app.post('/api/friends/accept/:requestId', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('friend_requests')
    .update({ status: 'accepted' })
    .eq('id', req.params.requestId)
    .eq('receiver_id', req.user.id)
    .eq('status', 'pending')
    .select()
    .single();
  if (error || !data) return res.status(400).json({ error: 'Request not found or already processed' });

  // Mutual follow
  await supabase.from('follows').upsert([
    { follower_id: req.user.id, following_id: data.sender_id },
    { follower_id: data.sender_id, following_id: req.user.id },
  ]);

  res.json({ success: true });
});

// Reject friend request
app.post('/api/friends/reject/:requestId', auth, async (req, res) => {
  await supabase
    .from('friend_requests')
    .update({ status: 'rejected' })
    .eq('id', req.params.requestId)
    .eq('receiver_id', req.user.id);
  res.json({ success: true });
});

// Remove friend
app.delete('/api/friends/:friendId', auth, async (req, res) => {
  const fid = req.params.friendId;
  // Delete both directions of the friend request
  await supabase.from('friend_requests').delete()
    .or(`and(sender_id.eq.${req.user.id},receiver_id.eq.${fid}),and(sender_id.eq.${fid},receiver_id.eq.${req.user.id})`);
  // Unfollow both directions
  await supabase.from('follows').delete().eq('follower_id', req.user.id).eq('following_id', fid);
  await supabase.from('follows').delete().eq('follower_id', fid).eq('following_id', req.user.id);
  res.json({ success: true });
});

// Get my friends list
app.get('/api/friends', auth, async (req, res) => {
  const { data } = await supabase
    .from('user_friends')
    .select('friend_id,friend_username,friend_avatar,friend_display_name')
    .eq('user_id', req.user.id);
  res.json(data || []);
});

// Get pending friend requests (received)
app.get('/api/friends/requests', auth, async (req, res) => {
  const { data } = await supabase
    .from('friend_requests')
    .select('id,sender_id,status,created_at,users:sender_id(username,display_name,avatar_url)')
    .eq('receiver_id', req.user.id)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  res.json(data || []);
});


// ════════════════════════════════════════════════════════════════════════════
// SOCIAL / PROFILES
// ════════════════════════════════════════════════════════════════════════════

// Get user profile by username
app.get('/api/users/:username', optAuth, async (req, res) => {
  const { data: user } = await supabase
    .from('users')
    .select('id,username,avatar_url,display_name,bio,created_at')
    .eq('username', req.params.username)
    .single();
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { data: libraries } = await supabase
    .from('libraries')
    .select('*, items:library_items(count)')
    .eq('user_id', user.id)
    .eq('is_public', true);

  const { data: stats } = await supabase
    .from('user_stats')
    .select('*')
    .eq('id', user.id)
    .single();

  // Check friendship status if logged in
  let friendStatus = null;
  if (req.user) {
    const { data: fr } = await supabase
      .from('friend_requests')
      .select('id,status,sender_id')
      .or(`and(sender_id.eq.${req.user.id},receiver_id.eq.${user.id}),and(sender_id.eq.${user.id},receiver_id.eq.${req.user.id})`)
      .single();
    friendStatus = fr;
  }

  res.json({ user, libraries: libraries || [], stats, friendStatus });
});

// Activity feed
app.get('/api/feed', auth, async (req, res) => {
  const { page = 1, limit = 30 } = req.query;
  const from = (page - 1) * limit;
  const { data, error } = await supabase
    .from('activity_feed')
    .select('*')
    .eq('viewer_id', req.user.id)
    .order('created_at', { ascending: false })
    .range(from, from + Number(limit) - 1);
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});

// Global search
app.get('/api/search', optAuth, async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ users: [], items: [] });
  const [{ data: users }, { data: items }] = await Promise.all([
    supabase.from('users').select('id,username,avatar_url,display_name').ilike('username', `%${q}%`).limit(10),
    supabase.from('library_items').select('id,title,subtitle,cover_url,library_id,libraries(type,user_id)').ilike('title', `%${q}%`).limit(20),
  ]);
  res.json({ users: users || [], items: items || [] });
});


// ════════════════════════════════════════════════════════════════════════════
// METADATA SEARCH PROXIES (CORS bypass for external APIs)
// ════════════════════════════════════════════════════════════════════════════

// Films via TMDB
app.get('/api/search/films', async (req, res) => {
  const key = process.env.TMDB_API_KEY;
  if (!key) return res.status(503).json({ error: 'TMDB_API_KEY not set in .env' });
  try {
    const r = await fetch(`https://api.themoviedb.org/3/search/multi?api_key=${key}&query=${encodeURIComponent(req.query.q)}&include_adult=false`);
    const d = await r.json();
    res.json((d.results || []).filter(x => x.poster_path).slice(0, 16).map(x => ({
      ext_id: String(x.id),
      title: x.title || x.name,
      subtitle: (x.release_date || x.first_air_date || '').slice(0, 4),
      cover_url: `https://image.tmdb.org/t/p/w185${x.poster_path}`,
      metadata: { media_type: x.media_type, vote_average: x.vote_average },
    })));
  } catch (e) {
    res.status(500).json({ error: 'TMDB search failed' });
  }
});

// Books via Open Library
app.get('/api/search/books', async (req, res) => {
  try {
    const r = await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(req.query.q)}&limit=16&fields=key,title,author_name,cover_i,first_publish_year`);
    const d = await r.json();
    res.json((d.docs || []).filter(x => x.cover_i).slice(0, 16).map(x => ({
      ext_id: x.key,
      title: x.title,
      subtitle: (x.author_name || [])[0] || '',
      cover_url: `https://covers.openlibrary.org/b/id/${x.cover_i}-M.jpg`,
      metadata: { year: x.first_publish_year },
    })));
  } catch (e) {
    res.status(500).json({ error: 'Book search failed' });
  }
});

// Music via MusicBrainz
app.get('/api/search/music', async (req, res) => {
  try {
    const r = await fetch(
      `https://musicbrainz.org/ws/2/release/?query=release:${encodeURIComponent(req.query.q)}&limit=16&fmt=json`,
      { headers: { 'User-Agent': 'ShelfApp/2.0 (contact@shelf.app)' } }
    );
    const d = await r.json();
    res.json((d.releases || []).slice(0, 16).map(rel => ({
      ext_id: rel.id,
      title: rel.title,
      subtitle: (rel['artist-credit'] || []).map(a => a.name || a?.artist?.name).filter(Boolean).join(', '),
      cover_url: `https://coverartarchive.org/release/${rel.id}/front-250`,
      metadata: { date: rel.date },
    })));
  } catch (e) {
    res.status(500).json({ error: 'Music search failed' });
  }
});

// Games via IGDB
app.get('/api/search/games', async (req, res) => {
  const clientId = process.env.IGDB_CLIENT_ID;
  const token = process.env.IGDB_ACCESS_TOKEN;
  if (!clientId || !token) return res.status(503).json({ error: 'IGDB credentials not set in .env' });
  try {
    const body = `search "${req.query.q}"; fields name,cover.url,first_release_date,platforms.abbreviation,genres.name,rating; limit 16; where cover != null;`;
    const r = await fetch('https://api.igdb.com/v4/games', {
      method: 'POST',
      headers: { 'Client-ID': clientId, 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
      body,
    });
    const games = await r.json();
    res.json((games || []).map(g => ({
      ext_id: String(g.id),
      title: g.name,
      subtitle: (g.platforms || []).map(p => p.abbreviation).slice(0, 2).join('/'),
      cover_url: g.cover?.url?.replace('t_thumb', 't_cover_big').replace('//', 'https://'),
      metadata: {
        igdb_id: g.id,
        genres: (g.genres || []).map(x => x.name),
        rating: g.rating ? Math.round(g.rating) : null,
        year: g.first_release_date ? new Date(g.first_release_date * 1000).getFullYear() : null,
      },
    })));
  } catch (e) {
    res.status(500).json({ error: 'Game search failed' });
  }
});


// ════════════════════════════════════════════════════════════════════════════
// ALBUM CACHE — Last.fm API (real popularity data, sorted by listener count)
// ════════════════════════════════════════════════════════════════════════════
/*
 * WHY LAST.FM:
 * - tag.getTopAlbums returns albums sorted by ACTUAL listener count
 * - "hip-hop" tag → Illmatic, Ready to Die, MBDTF first (not "DJ Eezy Instrumentals Vol.8")
 * - Free API key, 5 req/sec, no user auth needed
 * - Returns cover art URLs from Last.fm CDN
 *
 * HOW IT WORKS:
 * 1. POST /api/albums/seed → fetches 1000 top albums per genre from Last.fm
 * 2. For each album, gets year from Last.fm album.getInfo
 * 3. Stores in cached_albums: title, artist, year, cover URL, listeners, genre
 * 4. GET /api/albums/browse → reads from Supabase, filters by genre + year
 * 5. All users read from YOUR DB — Last.fm is never called per-user
 *
 * STORAGE: ~500 bytes/album. 10 genres × 1000 albums = 5MB total. Tiny.
 *
 * SETUP: Add to .env:
 *   LASTFM_API_KEY=your-lastfm-api-key
 *   (Get free at https://www.last.fm/api/account/create)
 */

const LASTFM_KEY = process.env.LASTFM_API_KEY || '';
const LASTFM_BASE = 'https://ws.audioscrobbler.com/2.0/';

const LASTFM_GENRE_TAGS = {
  'rock': 'rock',
  'hip-hop': 'hip-hop',
  'pop': 'pop',
  'rnb': 'rnb',
  'electronic': 'electronic',
  'metal': 'metal',
  'jazz': 'jazz',
  'country': 'country',
  'indie': 'indie',
  'folk': 'folk',
  'punk': 'punk',
  'classical': 'classical',
  'blues': 'blues',
  'soul': 'soul',
  'reggae': 'reggae',
  'latin': 'latin',
};

// Fetch top albums for a genre tag from Last.fm (sorted by listeners)
async function fetchLastfmTopAlbums(tag, page = 1, limit = 200) {
  if (!LASTFM_KEY) return [];
  try {
    const url = `${LASTFM_BASE}?method=tag.getTopAlbums&tag=${encodeURIComponent(tag)}&api_key=${LASTFM_KEY}&format=json&page=${page}&limit=${limit}`;
    const res = await fetch(url);
    const data = await res.json();
    return (data?.albums?.album || []).map(a => ({
      title: a.name,
      artist: a.artist?.name || '',
      listeners: parseInt(a.playcount || a.tagcount || '0'),
      // Last.fm images: [0]=small, [1]=medium, [2]=large, [3]=extralarge
      cover: a.image?.[3]?.['#text'] || a.image?.[2]?.['#text'] || '',
      mbid: a.mbid || '',
    })).filter(a => a.title && a.artist && a.cover);
  } catch (e) {
    console.error(`Last.fm tag.getTopAlbums error (${tag}):`, e.message);
    return [];
  }
}

// Get album info (year) from Last.fm
async function getAlbumYear(artist, album) {
  if (!LASTFM_KEY) return null;
  try {
    const url = `${LASTFM_BASE}?method=album.getInfo&artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}&api_key=${LASTFM_KEY}&format=json`;
    const res = await fetch(url);
    const data = await res.json();
    // Last.fm wiki may contain release date, or tags with year
    const wiki = data?.album?.wiki?.published || '';
    const match = wiki.match(/(\d{4})/);
    if (match) return parseInt(match[1]);
    // Try release date from tags
    const tags = (data?.album?.tags?.tag || []).map(t => t.name);
    for (const t of tags) {
      const ym = t.match(/^(\d{4})$/);
      if (ym) return parseInt(ym[1]);
    }
    return null;
  } catch {
    return null;
  }
}

// ── Browse endpoint — reads from Supabase cache ──────────────────────────
// GET /api/albums/browse?genre=rock&year=2017&page=1&limit=100
app.get('/api/albums/browse', async (req, res) => {
  try {
    const genre = req.query.genre || 'all';
    const year = req.query.year ? parseInt(req.query.year) : null;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, parseInt(req.query.limit) || 100);
    const offset = (page - 1) * limit;

    // ── CASE 1: No year filter → serve from Last.fm tag cache (fast) ──
    if (!year) {
      let query = supabase
        .from('cached_albums')
        .select('*')
        .order('popularity', { ascending: false })
        .range(offset, offset + limit - 1);
      if (genre !== 'all') query = query.eq('genre', genre);
      const { data, error } = await query;
      if (error) return res.status(500).json({ error: 'Database error' });
      return res.json({ albums: data || [], source: 'cache', total: (data||[]).length, page, limit });
    }

    // ── CASE 2: Year filter → read from cache (populated by seed-years) ────
    // The cached_albums table is pre-filled by POST /api/albums/seed-years
    // which uses Last.fm year tags (tag.getTopAlbums&tag=2017) — already
    // sorted by real play count. No runtime API calls needed.
    let cacheQuery = supabase
      .from('cached_albums')
      .select('*')
      .eq('year', year)
      .order('popularity', { ascending: false })
      .range(offset, offset + limit - 1);
    if (genre !== 'all') cacheQuery = cacheQuery.eq('genre', genre);
    const { data: cached } = await cacheQuery;

    return res.json({
      albums: cached || [],
      source: 'cache',
      total: (cached || []).length,
      page, limit
    });
  } catch (e) {
    console.error('Browse albums error:', e);
    res.status(500).json({ error: 'Failed to fetch albums' });
  }
});

// ── Seed endpoint — fetches from Last.fm and populates Supabase ──────────
// POST /api/albums/seed   body: { genre: "rock", pages: 5 }
// Each page = 200 albums. 5 pages = 1000 albums per genre.
app.post('/api/albums/seed', async (req, res) => {
  if (!LASTFM_KEY) {
    return res.status(400).json({ error: 'LASTFM_API_KEY not set in .env' });
  }

  const genre = req.body.genre;
  const pages = Math.min(req.body.pages || 5, 10); // max 10 pages = 2000 albums
  const tag = LASTFM_GENRE_TAGS[genre];

  if (!tag) {
    return res.status(400).json({
      error: `Invalid genre: ${genre}`,
      valid: Object.keys(LASTFM_GENRE_TAGS)
    });
  }

  console.log(`[Seed] Starting: ${genre} (${pages} pages × 200 = ${pages*200} albums)`);
  let totalSeeded = 0;
  let totalWithYear = 0;

  for (let p = 1; p <= pages; p++) {
    console.log(`[Seed] ${genre} page ${p}/${pages}...`);
    const albums = await fetchLastfmTopAlbums(tag, p, 200);

    if (albums.length === 0) {
      console.log(`[Seed] No more albums for ${genre} at page ${p}`);
      break;
    }

    // Get years for each album (with rate limiting)
    const rows = [];
    let idx = 0;
    for (const album of albums) {
      // Create a stable ID from artist+title
      const id = `lfm-${Buffer.from(album.artist + '|' + album.title).toString('base64').slice(0, 40)}`;

      let year = null;
      // Try to get year (rate limited — 5 req/sec, so 200ms delay)
      try {
        year = await getAlbumYear(album.artist, album.title);
        await new Promise(r => setTimeout(r, 210));
      } catch {}

      if (year) totalWithYear++;

      rows.push({
        id,
        title: album.title,
        artist: album.artist,
        year: year,
        cover_url: album.cover,
        genre: genre,
        // Position-based: page 1 idx 0 = highest score
        popularity: ((pages + 1 - p) * 200 + (200 - idx)) * 100,
        track_count: 0,
        spotify_url: '',
        fetched_at: new Date().toISOString(),
      });
      idx++;
    }

    // Upsert batch into Supabase
    if (rows.length > 0) {
      const { error } = await supabase
        .from('cached_albums')
        .upsert(rows, { onConflict: 'id' });

      if (error) {
        console.error(`[Seed] Supabase upsert error:`, error.message);
      } else {
        totalSeeded += rows.length;
        console.log(`[Seed] ${genre} page ${p}: ${rows.length} albums cached (${totalWithYear} with year)`);
      }
    }
  }

  console.log(`[Seed] Done: ${genre} → ${totalSeeded} albums total`);
  res.json({
    message: `Seeded ${totalSeeded} albums for genre: ${genre}`,
    total: totalSeeded,
    withYear: totalWithYear,
    genre
  });
});

// ── Seed ALL genres at once ──────────────────────────────────────────────
// POST /api/albums/seed-all   body: { pages: 3 }
app.post('/api/albums/seed-all', async (req, res) => {
  if (!LASTFM_KEY) {
    return res.status(400).json({ error: 'LASTFM_API_KEY not set in .env' });
  }

  const pages = Math.min(req.body.pages || 3, 5);
  const genres = Object.keys(LASTFM_GENRE_TAGS);
  const results = {};

  res.json({ message: `Seeding ${genres.length} genres × ${pages} pages in background. Check server logs.` });

  // Run in background (don't block response)
  (async () => {
    for (const genre of genres) {
      const tag = LASTFM_GENRE_TAGS[genre];
      let genreTotal = 0;
      for (let p = 1; p <= pages; p++) {
        console.log(`[Seed-All] ${genre} page ${p}/${pages}...`);
        const albums = await fetchLastfmTopAlbums(tag, p, 200);
        if (albums.length === 0) break;

        const rows = albums.map((album, idx) => ({
          id: `lfm-${Buffer.from(album.artist + '|' + album.title).toString('base64').slice(0, 40)}`,
          title: album.title, artist: album.artist, year: null,
          cover_url: album.cover, genre: genre,
          // Position-based: page 1 idx 0 = highest, page 5 idx 199 = lowest
          popularity: ((6 - p) * 200 + (200 - idx)) * 100,
          track_count: 0,
          spotify_url: '', fetched_at: new Date().toISOString(),
        }));

        await supabase.from('cached_albums').upsert(rows, { onConflict: 'id' });
        genreTotal += rows.length;
        await new Promise(r => setTimeout(r, 250)); // rate limit
      }
      console.log(`[Seed-All] ${genre}: ${genreTotal} albums cached`);
      results[genre] = genreTotal;
    }
    console.log('[Seed-All] COMPLETE:', results);
  })();
});

// ── Seed by YEAR — the key endpoint for year-based browsing ──────────────
// POST /api/albums/seed-years   body: { from: 1980, to: 2025 }
//
// HOW IT WORKS:
// Last.fm users tag albums with their release year: "1994", "2017", etc.
// tag.getTopAlbums&tag=2017 → returns albums tagged "2017" sorted by PLAY COUNT
// = the most-listened albums of 2017, ranked by real usage data.
//
// One call per year × 100 albums = 4,500 albums for 45 years.
// Each album already has: title, artist, play count, cover art.
// After seeding, every browse request is instant from Supabase.
//
// We also enrich each album with genre from album.getTopTags so users
// can filter by year AND genre (e.g. "hip-hop albums of 2014").
app.post('/api/albums/seed-years', async (req, res) => {
  if (!LASTFM_KEY) {
    return res.status(400).json({ error: 'LASTFM_API_KEY not set in .env' });
  }

  const fromYear = parseInt(req.body.from) || 1980;
  const toYear = parseInt(req.body.to) || 2025;
  const perYear = Math.min(parseInt(req.body.limit) || 100, 200);

  console.log(`[Seed-Years] Starting: ${fromYear}–${toYear}, ${perYear} albums per year`);
  res.json({ message: `Seeding years ${fromYear}–${toYear} (${perYear}/year) in background. Check server logs.` });

  // Run in background
  (async () => {
    let grandTotal = 0;

    for (let year = toYear; year >= fromYear; year--) {
      console.log(`[Seed-Years] Fetching ${year}...`);

      try {
        // 1. Get top albums for this year tag, sorted by play count
        const url = `${LASTFM_BASE}?method=tag.getTopAlbums&tag=${year}&api_key=${LASTFM_KEY}&format=json&page=1&limit=${perYear}`;
        const response = await fetch(url);
        const data = await response.json();
        const albums = data?.albums?.album || [];

        if (albums.length === 0) {
          console.log(`[Seed-Years] ${year}: no results, skipping`);
          continue;
        }

        // 2. Build rows — Last.fm ALREADY returns these sorted by real popularity.
        //    Position 0 = most popular album for this year tag.
        //    We store position as the popularity score so ORDER BY popularity DESC
        //    preserves Last.fm's real ranking. The playcount field from tag.getTopAlbums
        //    is a TAG count (how many users applied this tag), NOT album plays — useless for sorting.
        const rows = [];
        for (let idx = 0; idx < albums.length; idx++) {
          const a = albums[idx];
          const title = a.name;
          const artist = a.artist?.name || '';
          if (!title || !artist) continue;

          // Position-based score: #1 most popular = highest number
          const popularity = (perYear - idx) * 1000;

          // Cover from Last.fm
          const cover = a.image?.[3]?.['#text'] || a.image?.[2]?.['#text'] || '';

          // Stable ID
          const id = `yr-${year}-${Buffer.from(artist + '|' + title).toString('base64').replace(/[/+=]/g, '').slice(0, 30)}`;

          rows.push({
            id,
            title,
            artist,
            year: year,
            cover_url: cover,
            genre: 'all', // will be enriched below
            popularity,
            track_count: 0,
            spotify_url: '',
            fetched_at: new Date().toISOString(),
          });
        }

        // 3. Enrich with genre tags (batch 5 at a time, rate-limited)
        //    Last.fm album.getTopTags tells us the genre
        const BATCH = 5;
        for (let i = 0; i < Math.min(rows.length, 100); i += BATCH) {
          const batch = rows.slice(i, i + BATCH);
          const promises = batch.map(async (row) => {
            try {
              const tagUrl = `${LASTFM_BASE}?method=album.getTopTags&artist=${encodeURIComponent(row.artist)}&album=${encodeURIComponent(row.title)}&api_key=${LASTFM_KEY}&format=json`;
              const tagRes = await fetch(tagUrl);
              const tagData = await tagRes.json();
              const tags = (tagData?.toptags?.tag || []).map(t => t.name.toLowerCase());

              // Map Last.fm tags to our genre categories
              const genreMap = {
                'hip-hop': ['hip-hop','hip hop','rap','trap','hiphop'],
                'rock': ['rock','classic rock','hard rock','alternative rock','punk rock','grunge'],
                'pop': ['pop','synth pop','synthpop','dance pop','electropop','k-pop'],
                'rnb': ['rnb','r&b','rhythm and blues','neo-soul','neo soul'],
                'electronic': ['electronic','edm','house','techno','ambient','trance','dubstep'],
                'metal': ['metal','heavy metal','death metal','black metal','thrash metal','progressive metal'],
                'jazz': ['jazz','smooth jazz','bebop','fusion'],
                'country': ['country','americana','bluegrass'],
                'indie': ['indie','indie rock','indie pop','shoegaze','dream pop','post-punk'],
                'folk': ['folk','singer-songwriter','acoustic','folk rock'],
                'punk': ['punk','punk rock','post-punk','hardcore','emo'],
                'soul': ['soul','motown','funk','disco'],
                'classical': ['classical','orchestra','symphony','baroque'],
                'blues': ['blues','delta blues','chicago blues'],
                'reggae': ['reggae','ska','dub'],
                'latin': ['latin','reggaeton','salsa','bossa nova'],
              };

              for (const [genre, keywords] of Object.entries(genreMap)) {
                if (tags.some(t => keywords.some(k => t.includes(k)))) {
                  row.genre = genre;
                  break;
                }
              }
            } catch {}
          });
          await Promise.all(promises);
          await new Promise(r => setTimeout(r, 220)); // rate limit
        }

        // 4. Upsert into Supabase
        if (rows.length > 0) {
          const { error } = await supabase
            .from('cached_albums')
            .upsert(rows, { onConflict: 'id' });

          if (error) {
            console.error(`[Seed-Years] ${year}: upsert error:`, error.message);
          } else {
            const genreCounts = {};
            rows.forEach(r => { genreCounts[r.genre] = (genreCounts[r.genre]||0)+1; });
            console.log(`[Seed-Years] ${year}: ${rows.length} albums cached. Genres:`, genreCounts);
            grandTotal += rows.length;
          }
        }

        // Rate limit between years
        await new Promise(r => setTimeout(r, 300));

      } catch (e) {
        console.error(`[Seed-Years] ${year}: error:`, e.message);
      }
    }

    console.log(`[Seed-Years] ══════ COMPLETE: ${grandTotal} total albums from ${fromYear}–${toYear} ══════`);
  })();
});

// ── Stats endpoint ──────────────────────────────────────────────────────
app.get('/api/albums/stats', async (req, res) => {
  try {
    // Count albums per genre
    const { data } = await supabase
      .from('cached_albums')
      .select('genre');

    const counts = {};
    (data || []).forEach(r => { counts[r.genre] = (counts[r.genre] || 0) + 1; });

    const total = Object.values(counts).reduce((s, n) => s + n, 0);
    res.json({ total, genres: counts });
  } catch (e) {
    res.json({ total: 0, genres: {} });
  }
});



// ════════════════════════════════════════════════════════════════════════════


// ════════════════════════════════════════════════════════════════════════════
// TOP ARTISTS — Spotify API (Client Credentials, no user login needed)
// ════════════════════════════════════════════════════════════════════════════
/*
 * STRATEGY (same as ChartMasters):
 * 1. Start with 100 seed artists (the biggest names worldwide)
 * 2. For each seed: Spotify "Get Related Artists" → 20 more artists
 * 3. 100 seeds × 20 related = 2000+ artists, all with real data
 * 4. Each artist: name, followers, popularity, genres, photo from Spotify
 * 5. Store in cached_artists → users browse from your DB, zero API calls
 *
 * SETUP: Add to .env:
 *   SPOTIFY_CLIENT_ID=your-spotify-client-id
 *   SPOTIFY_CLIENT_SECRET=your-spotify-client-secret
 *   (Free at https://developer.spotify.com/dashboard)
 */

let spotifyToken = null;
let spotifyTokenExpiry = 0;

async function getSpotifyToken() {
  if (spotifyToken && Date.now() < spotifyTokenExpiry) return spotifyToken;
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  try {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64')
      },
      body: 'grant_type=client_credentials'
    });
    const data = await res.json();
    spotifyToken = data.access_token;
    spotifyTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return spotifyToken;
  } catch (e) {
    console.error('Spotify token error:', e.message);
    return null;
  }
}

// Map Spotify genres to our categories
function mapSpotifyGenre(genres) {
  const g = (genres || []).join(' ').toLowerCase();
  if (/hip.?hop|rap|trap/.test(g)) return 'hip-hop';
  if (/rock|grunge|punk rock/.test(g)) return 'rock';
  if (/pop(?!.*punk)/.test(g) && !/k-pop/.test(g)) return 'pop';
  if (/k-pop|k pop/.test(g)) return 'k-pop';
  if (/r&b|rnb|soul|neo.?soul|motown/.test(g)) return 'rnb';
  if (/electro|edm|house|techno|dance|ambient/.test(g)) return 'electronic';
  if (/metal|death|thrash|doom/.test(g)) return 'metal';
  if (/jazz|bebop|swing/.test(g)) return 'jazz';
  if (/country|americana|bluegrass/.test(g)) return 'country';
  if (/indie|alternative/.test(g)) return 'indie';
  if (/folk|singer.?song/.test(g)) return 'folk';
  if (/punk|hardcore|emo/.test(g)) return 'punk';
  if (/classical|orchestra|symphony/.test(g)) return 'classical';
  if (/reggae|ska|dub/.test(g)) return 'reggae';
  if (/blues/.test(g)) return 'blues';
  if (/latin|reggaeton|salsa/.test(g)) return 'latin';
  return 'other';
}

// 100 seed artists — the biggest names worldwide across all genres
const SEED_ARTISTS = [
  // Pop
  'Taylor Swift','Ed Sheeran','Adele','Billie Eilish','Harry Styles','Dua Lipa','Bruno Mars',
  'Lady Gaga','Ariana Grande','Justin Bieber','Rihanna','Beyoncé','Shakira','Katy Perry',
  'The Weeknd','Post Malone','Doja Cat','Olivia Rodrigo','SZA','Bad Bunny',
  // Rock
  'Queen','The Beatles','Led Zeppelin','Pink Floyd','Nirvana','Radiohead','Coldplay',
  'Linkin Park','Foo Fighters','AC/DC','Guns N Roses','Red Hot Chili Peppers','U2',
  'Imagine Dragons','Arctic Monkeys','Muse','Pearl Jam','Oasis','The Rolling Stones','Green Day',
  // Hip Hop
  'Eminem','Drake','Kanye West','Kendrick Lamar','Jay-Z','Travis Scott','J. Cole',
  'Lil Wayne','50 Cent','Snoop Dogg','Nicki Minaj','Future','21 Savage','Lil Baby',
  'Tyler, the Creator','Mac Miller','Juice WRLD','XXXTentacion','A$AP Rocky','Cardi B',
  // R&B / Soul
  'Frank Ocean','Daniel Caesar','Stevie Wonder','Marvin Gaye','Alicia Keys','Usher',
  'Chris Brown','Khalid','H.E.R.','Summer Walker',
  // Electronic
  'Daft Punk','Calvin Harris','David Guetta','Marshmello','Skrillex','Avicii','Tiësto',
  'Deadmau5','Martin Garrix','Kygo',
  // Metal
  'Metallica','Iron Maiden','Black Sabbath','Slipknot','System of a Down','Tool',
  'Avenged Sevenfold','Rammstein',
  // Latin
  'J Balvin','Ozuna','Daddy Yankee','Maluma','Rosalía','Karol G',
  // Country
  'Morgan Wallen','Luke Combs','Chris Stapleton','Zach Bryan',
  // Jazz
  'Miles Davis','Louis Armstrong',
  // K-Pop
  'BTS','BLACKPINK','Stray Kids','TWICE',
  // Other global
  'Bob Marley','Michael Jackson','Elvis Presley','David Bowie','Prince','Whitney Houston',
  'Elton John','Madonna','Amy Winehouse','Lana Del Rey',
];

// Search Spotify for an artist by name, return full artist object
async function searchSpotifyArtist(token, name) {
  try {
    const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(name)}&type=artist&limit=1&market=US`;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    const data = await res.json();
    return data?.artists?.items?.[0] || null;
  } catch { return null; }
}

async function searchSpotifyArtists(token, query, offset = 0, limit = 50) {
  try {
    const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=artist&limit=${limit}&offset=${offset}&market=US`;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    const data = await res.json();
    return data?.artists?.items || [];
  } catch {
    return [];
  }
}

// Get related artists for a Spotify artist ID
async function getRelatedArtists(token, artistId) {
  try {
    const url = `https://api.spotify.com/v1/artists/${artistId}/related-artists`;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    const data = await res.json();
    return data?.artists || [];
  } catch { return []; }
}

// Convert Spotify artist object to our DB row
function artistToRow(a) {
  return {
    id: a.id,
    name: a.name,
    followers: a.followers?.total || 0,
    popularity: a.popularity || 0,
    genres: a.genres || [],
    primary_genre: mapSpotifyGenre(a.genres),
    image_url: a.images?.[1]?.url || a.images?.[0]?.url || '',
    fetched_at: new Date().toISOString(),
  };
}

// ── Browse Artists endpoint ──────────────────────────────────────────────
// GET /api/artists/browse?genre=rock&page=1&limit=50&sort=followers
app.get('/api/artists/browse', async (req, res) => {
  try {
    const genre = req.query.genre || 'all';
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, parseInt(req.query.limit) || 50);
    const offset = (page - 1) * limit;
    const sort = req.query.sort === 'popularity' ? 'popularity' : 'followers';

    // Fast path for "all" genre
    if (genre === 'all') {
      const query = supabase
        .from('cached_artists')
        .select('*')
        .order(sort, { ascending: false })
        .range(offset, offset + limit - 1);
      const { data, error } = await query;
      if (error) return res.status(500).json({ error: 'Database error' });
      const { count: totalCount } = await supabase.from('cached_artists').select('*', { count: 'exact', head: true });
      return res.json({
        artists: data || [],
        total: totalCount || 0,
        page, limit, sort
      });
    }

    // Compatibility path:
    // older seeds may have primary_genre='other' for many artists.
    // In that case, fallback to dynamic mapSpotifyGenre(genres) filtering.
    const pageSize = 1000;
    let from = 0;
    const allRows = [];
    for (;;) {
      const { data, error } = await supabase
        .from('cached_artists')
        .select('*')
        .order(sort, { ascending: false })
        .range(from, from + pageSize - 1);
      if (error) return res.status(500).json({ error: 'Database error' });
      if (!data || data.length === 0) break;
      allRows.push(...data);
      if (data.length < pageSize) break;
      from += pageSize;
    }

    let filtered = allRows.filter((r) => {
      const pg = (r.primary_genre || '').toLowerCase();
      if (pg === genre) return true;
      return mapSpotifyGenre(r.genres || []) === genre;
    });

    // If old cached rows lack genre data, fallback to live Spotify genre search.
    if (filtered.length === 0) {
      const token = await getSpotifyToken();
      if (token) {
        const q = genre === 'hip-hop' ? 'hip hop' : genre === 'rnb' ? 'r&b' : genre;
        const live = [];
        const seen = new Set();
        for (const off of [0, 50]) {
          const items = await searchSpotifyArtists(token, q, off, 50);
          for (const a of items) {
            if (!a?.id || seen.has(a.id)) continue;
            const row = artistToRow(a);
            if (mapSpotifyGenre(row.genres || []) !== genre) continue;
            seen.add(a.id);
            live.push(row);
          }
          await new Promise(r => setTimeout(r, 80));
        }
        filtered = live.sort((a, b) => ((b[sort] || 0) - (a[sort] || 0)));
      }
    }

    res.json({
      artists: filtered.slice(offset, offset + limit),
      total: filtered.length,
      page, limit, sort
    });
  } catch (e) {
    console.error('Browse artists error:', e);
    res.status(500).json({ error: 'Failed to fetch artists' });
  }
});

// ── Artist Discography endpoint (albums only, no singles) ─────────────────
// GET /api/artists/:spotifyId/albums?market=US
app.get('/api/artists/:spotifyId/albums', async (req, res) => {
  const spotifyId = req.params.spotifyId || '';
  if (!/^[0-9A-Za-z]+$/.test(spotifyId)) {
    return res.status(400).json({ error: 'Invalid Spotify artist id', albums: [] });
  }

  const token = await getSpotifyToken();
  if (!token) {
    return res.status(503).json({ error: 'Spotify credentials missing or invalid', albums: [] });
  }

  const market = String(req.query.market || 'US').slice(0, 2).toUpperCase();
  const albums = [];
  const seen = new Set();
  let nextUrl = `https://api.spotify.com/v1/artists/${encodeURIComponent(spotifyId)}/albums?include_groups=album&market=${encodeURIComponent(market)}&limit=50`;

  try {
    while (nextUrl && albums.length < 500) {
      const r = await fetch(nextUrl, { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json();
      if (!r.ok) {
        return res.status(r.status || 500).json({ error: d?.error?.message || 'Spotify request failed', albums: [] });
      }

      for (const al of (d.items || [])) {
        if (!al?.id || seen.has(al.id)) continue;
        seen.add(al.id);
        albums.push({
          id: al.id,
          name: al.name || '',
          release_date: al.release_date || '',
          total_tracks: al.total_tracks || 0,
          images: al.images || [],
          external_urls: al.external_urls || {},
          artists: (al.artists || []).map(a => ({ id: a.id, name: a.name })),
        });
      }
      nextUrl = d.next || null;
      if (nextUrl) await new Promise(r => setTimeout(r, 60));
    }

    albums.sort((a, b) => String(b.release_date || '').localeCompare(String(a.release_date || '')));
    res.json({ albums });
  } catch (e) {
    console.error('Artist albums error:', e.message);
    res.status(500).json({ error: 'Failed to load artist albums', albums: [] });
  }
});

// ── Seed Artists endpoint ────────────────────────────────────────────────
// POST /api/artists/seed
// Strategy: 100 seeds → search each on Spotify → get related → 2000+ artists
app.post('/api/artists/seed', async (req, res) => {
  const token = await getSpotifyToken();
  if (!token) {
    return res.status(400).json({ error: 'Spotify credentials not set. Add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to .env' });
  }

  console.log(`[Artist Seed] Starting with ${SEED_ARTISTS.length} seed artists...`);
  res.json({ message: `Seeding artists from ${SEED_ARTISTS.length} seeds + related artists. Check server logs.` });

  // Run in background
  (async () => {
    const seen = new Set();
    const allRows = [];

    // Phase 1: Search each seed artist on Spotify
    console.log('[Artist Seed] Phase 1: Searching seed artists...');
    const seedIds = [];
    for (let i = 0; i < SEED_ARTISTS.length; i++) {
      const name = SEED_ARTISTS[i];
      const artist = await searchSpotifyArtist(token, name);
      if (artist && !seen.has(artist.id)) {
        seen.add(artist.id);
        seedIds.push(artist.id);
        allRows.push(artistToRow(artist));
        if ((i + 1) % 10 === 0) console.log(`[Artist Seed] Phase 1: ${i + 1}/${SEED_ARTISTS.length} seeds found (${allRows.length} total)`);
      }
      await new Promise(r => setTimeout(r, 100)); // rate limit
    }
    console.log(`[Artist Seed] Phase 1 complete: ${seedIds.length} seed artists found`);

    // Phase 2: Get related artists for each seed
    console.log('[Artist Seed] Phase 2: Expanding via related artists...');
    for (let i = 0; i < seedIds.length; i++) {
      const related = await getRelatedArtists(token, seedIds[i]);
      for (const a of related) {
        if (!seen.has(a.id)) {
          seen.add(a.id);
          allRows.push(artistToRow(a));
        }
      }
      if ((i + 1) % 20 === 0) console.log(`[Artist Seed] Phase 2: ${i + 1}/${seedIds.length} seeds expanded (${allRows.length} total artists)`);
      await new Promise(r => setTimeout(r, 100));
    }
    console.log(`[Artist Seed] Phase 2 complete: ${allRows.length} total unique artists`);

    // Phase 3: Upsert all into Supabase in batches of 100
    console.log('[Artist Seed] Phase 3: Saving to database...');
    let saved = 0;
    for (let i = 0; i < allRows.length; i += 100) {
      const batch = allRows.slice(i, i + 100);
      const { error } = await supabase.from('cached_artists').upsert(batch, { onConflict: 'id' });
      if (error) console.error('[Artist Seed] Upsert error:', error.message);
      else saved += batch.length;
    }

    // Genre breakdown
    const genreCounts = {};
    allRows.forEach(r => { genreCounts[r.primary_genre] = (genreCounts[r.primary_genre] || 0) + 1; });

    console.log(`[Artist Seed] ══════ COMPLETE ══════`);
    console.log(`[Artist Seed] Total: ${saved} artists saved`);
    console.log(`[Artist Seed] Genres:`, genreCounts);
  })();
});

// ── Artist Stats endpoint ────────────────────────────────────────────────
app.get('/api/artists/stats', async (req, res) => {
  try {
    const { data } = await supabase.from('cached_artists').select('primary_genre');
    const counts = {};
    (data || []).forEach(r => { counts[r.primary_genre] = (counts[r.primary_genre] || 0) + 1; });
    const total = Object.values(counts).reduce((s, n) => s + n, 0);
    res.json({ total, genres: counts });
  } catch { res.json({ total: 0, genres: {} }); }
});


// ════════════════════════════════════════════════════════════════════════════
// STEAM INTEGRATION — Import user's game library with playtime
// ════════════════════════════════════════════════════════════════════════════
/*
 * HOW IT WORKS:
 * 1. User enters their Steam ID or vanity URL name
 * 2. Server resolves vanity name → Steam64 ID (if needed)
 * 3. Server calls Steam IPlayerService/GetOwnedGames → all games with playtime
 * 4. Returns: game name, appid, playtime (hours), cover image URL
 * 5. Frontend imports them into the Games library
 *
 * SETUP: Add to .env:
 *   STEAM_API_KEY=your-steam-web-api-key
 *   (Free at https://steamcommunity.com/dev/apikey)
 *
 * NOTE: User's Steam profile must be PUBLIC for this to work.
 */

const STEAM_KEY = process.env.STEAM_API_KEY || '';

// Resolve Steam vanity URL name → Steam64 ID
app.get('/api/steam/resolve/:vanityName', async (req, res) => {
  if (!STEAM_KEY) return res.status(503).json({ error: 'STEAM_API_KEY not set in .env' });
  try {
    const url = `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${STEAM_KEY}&vanityurl=${encodeURIComponent(req.params.vanityName)}`;
    const r = await fetch(url);
    const data = await r.json();
    if (data?.response?.success === 1) {
      res.json({ steamId: data.response.steamid });
    } else {
      res.status(404).json({ error: 'Steam user not found. Make sure you use your Steam custom URL name or 64-bit ID.' });
    }
  } catch (e) {
    res.status(500).json({ error: 'Failed to resolve Steam ID' });
  }
});

// Get a user's owned games with playtime
app.get('/api/steam/library/:steamId', async (req, res) => {
  if (!STEAM_KEY) return res.status(503).json({ error: 'STEAM_API_KEY not set in .env' });
  try {
    const steamId = req.params.steamId;
    const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${STEAM_KEY}&steamid=${steamId}&include_appinfo=1&include_played_free_games=1&format=json`;
    const r = await fetch(url);
    const data = await r.json();
    const games = data?.response?.games || [];

    if (games.length === 0) {
      return res.json({ games: [], total: 0, note: 'No games found. Is the Steam profile set to PUBLIC?' });
    }

    // Sort by playtime descending (most played first)
    games.sort((a, b) => (b.playtime_forever || 0) - (a.playtime_forever || 0));

    const result = games.map(g => ({
      ext_id: `steam-${g.appid}`,
      appid: g.appid,
      title: g.name || `App ${g.appid}`,
      // Steam library cover (600x900 portrait) with header fallback
      cover_url: `https://steamcdn-a.akamaihd.net/steam/apps/${g.appid}/library_600x900_2x.jpg`,
      cover_fallback: `https://steamcdn-a.akamaihd.net/steam/apps/${g.appid}/header.jpg`,
      playtime_hours: Math.round((g.playtime_forever || 0) / 60 * 10) / 10,
      playtime_2weeks: Math.round((g.playtime_2weeks || 0) / 60 * 10) / 10,
      metadata: {
        platform: 'Steam',
        appid: g.appid,
        playtime_minutes: g.playtime_forever || 0,
        playtime_2weeks_minutes: g.playtime_2weeks || 0,
      }
    }));

    res.json({ games: result, total: result.length, steamId });
  } catch (e) {
    console.error('Steam library error:', e.message);
    res.status(500).json({ error: 'Failed to fetch Steam library' });
  }
});


// HEALTH CHECK
// ════════════════════════════════════════════════════════════════════════════
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '2.0.0', timestamp: new Date().toISOString() });
});

// Main UI
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});


// ════════════════════════════════════════════════════════════════════════════
// START — with graceful port handling
// ════════════════════════════════════════════════════════════════════════════
const PORT = parseInt(process.env.PORT, 10) || 3001;

function startServer(port) {
  port = parseInt(port, 10) || 3001;
  const server = app.listen(port, () => {
    console.log(`\n  ┌─────────────────────────────────────────┐`);
    console.log(`  │  SHELF API running on port ${port}          │`);
    console.log(`  │  http://localhost:${port}/api/health        │`);
    console.log(`  └─────────────────────────────────────────┘\n`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`  ⚠ Port ${port} is in use, trying ${port + 1}...`);
      startServer(port + 1);
    } else {
      console.error('Server error:', err);
      process.exit(1);
    }
  });
}

startServer(PORT);
