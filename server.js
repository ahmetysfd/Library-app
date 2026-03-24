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

const crypto = require('crypto');
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

// Chrome DevTools probes this URL — without a route it shows 404 in the Network tab.
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
 * 3. Stores in cached_albums: title, artist, year, cover URL, popularity (position score), genre
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

// Fetch top albums for a genre tag from Last.fm.
// API order = real popularity order, but playcount/tagcount are NOT comparable across rows.
// We store position-based scores so ORDER BY popularity DESC matches Last.fm order.
async function fetchLastfmTopAlbums(tag, page = 1, limit = 200) {
  if (!LASTFM_KEY) return [];
  try {
    const url = `${LASTFM_BASE}?method=tag.getTopAlbums&tag=${encodeURIComponent(tag)}&api_key=${LASTFM_KEY}&format=json&page=${page}&limit=${limit}`;
    const res = await fetch(url);
    const data = await res.json();
    const raw = data?.albums?.album || [];
    return raw.map((a, idx) => {
      const globalRank = (page - 1) * limit + idx + 1;
      // High score = higher on Last.fm chart (same order as API response).
      const popularityScore = Math.max(1, 1_000_000 - globalRank);
      return {
        title: a.name,
        artist: a.artist?.name || '',
        popularityScore,
        cover: a.image?.[3]?.['#text'] || a.image?.[2]?.['#text'] || '',
        mbid: a.mbid || '',
      };
    }).filter(a => a.title && a.artist && a.cover);
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
      let countQ = supabase.from('cached_albums').select('*', { count: 'exact', head: true });
      if (genre !== 'all') countQ = countQ.eq('genre', genre);
      const { count: totalMatching } = await countQ;

      let query = supabase
        .from('cached_albums')
        .select('*')
        .order('popularity', { ascending: false })
        .range(offset, offset + limit - 1);
      if (genre !== 'all') query = query.eq('genre', genre);
      const { data, error } = await query;
      if (error) return res.status(500).json({ error: 'Database error' });
      return res.json({
        albums: data || [],
        source: 'cache',
        total: totalMatching ?? (data || []).length,
        page,
        limit
      });
    }

    // ── CASE 2: Year filter → read from cache (populated by seed-years) ────
    // The cached_albums table is pre-filled by POST /api/albums/seed-years
    // (Last.fm year-tag charts). popularity = position score so ORDER BY matches chart order.
    let countYearQ = supabase.from('cached_albums').select('*', { count: 'exact', head: true }).eq('year', year);
    if (genre !== 'all') countYearQ = countYearQ.eq('genre', genre);
    const { count: totalForYear } = await countYearQ;

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
      total: totalForYear ?? (cached || []).length,
      page,
      limit
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
        popularity: album.popularityScore,
        track_count: 0,
        spotify_url: '',
        fetched_at: new Date().toISOString(),
      });
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

        const rows = albums.map(album => ({
          id: `lfm-${Buffer.from(album.artist + '|' + album.title).toString('base64').slice(0, 40)}`,
          title: album.title, artist: album.artist, year: null,
          cover_url: album.cover, genre: genre,
          popularity: album.popularityScore, track_count: 0,
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

        // 2. Build rows — popularity = list position only (Last.fm order is already correct;
        //    playcount/tagcount here are tag-application counts, not comparable across rows)
        const rows = [];
        for (let idx = 0; idx < albums.length; idx++) {
          const a = albums[idx];
          const title = a.name;
          const artist = a.artist?.name || '';
          if (!title || !artist) continue;

          const popularity = Math.max(1, 1_000_000 - idx);

          // Cover from Last.fm
          const cover = a.image?.[3]?.['#text'] || a.image?.[2]?.['#text'] || '';

          // Stable ID (full hash — truncated base64 could collide → duplicate PK in one upsert)
          const id = `yr-${year}-${crypto.createHash('md5').update(`${artist}|${title}`).digest('hex')}`;

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

        // 4. Dedupe by id (Last.fm sometimes returns duplicate entries in one response)
        const byId = new Map();
        for (const row of rows) {
          if (!byId.has(row.id)) byId.set(row.id, row);
        }
        const uniqueRows = [...byId.values()];

        // 5. Upsert into Supabase
        if (uniqueRows.length > 0) {
          const { error } = await supabase
            .from('cached_albums')
            .upsert(uniqueRows, { onConflict: 'id' });

          if (error) {
            console.error(`[Seed-Years] ${year}: upsert error:`, error.message);
          } else {
            const genreCounts = {};
            uniqueRows.forEach(r => { genreCounts[r.genre] = (genreCounts[r.genre]||0)+1; });
            console.log(`[Seed-Years] ${year}: ${uniqueRows.length} albums cached. Genres:`, genreCounts);
            grandTotal += uniqueRows.length;
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
// ARTIST CACHE — Spotify top artists (Client Credentials)
// ════════════════════════════════════════════════════════════════════════════
let spotifyArtistToken = null;
let spotifyArtistTokenExpiry = 0;

async function getSpotifyArtistToken() {
  if (spotifyArtistToken && Date.now() < spotifyArtistTokenExpiry) return spotifyArtistToken;

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
    if (!data.access_token) return null;
    spotifyArtistToken = data.access_token;
    spotifyArtistTokenExpiry = Date.now() + ((data.expires_in || 3600) - 60) * 1000;
    return spotifyArtistToken;
  } catch {
    return null;
  }
}

function normalizeGenreTag(g = '') {
  const x = g.toLowerCase();
  if (x.includes('hip hop') || x.includes('rap') || x.includes('trap')) return 'hip-hop';
  if (x.includes('r&b') || x.includes('rnb') || x.includes('rhythm')) return 'rnb';
  if (x.includes('electronic') || x.includes('edm') || x.includes('house') || x.includes('techno')) return 'electronic';
  if (x.includes('metal')) return 'metal';
  if (x.includes('jazz')) return 'jazz';
  if (x.includes('country')) return 'country';
  if (x.includes('reggae')) return 'reggae';
  if (x.includes('latin') || x.includes('reggaeton')) return 'latin';
  if (x.includes('blues')) return 'blues';
  if (x.includes('classical') || x.includes('orchestra') || x.includes('symphony')) return 'classical';
  if (x.includes('punk')) return 'punk';
  if (x.includes('indie') || x.includes('shoegaze') || x.includes('dream pop')) return 'indie';
  if (x.includes('folk') || x.includes('singer-songwriter')) return 'folk';
  if (x.includes('rock')) return 'rock';
  if (x.includes('pop')) return 'pop';
  return 'other';
}

async function spotifySearchArtists(token, query, offset = 0, limit = 50) {
  const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=artist&market=US&limit=${limit}&offset=${offset}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data?.artists?.items || [];
}

/** PostgREST returns max ~1000 rows per request — page through for full table scans. */
async function supabaseSelectAll(table, columns = '*') {
  const pageSize = 1000;
  const all = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase.from(table).select(columns).range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

// POST /api/artists/seed
// body: { target: 2000, reset: false }
app.post('/api/artists/seed', async (req, res) => {
  const token = await getSpotifyArtistToken();
  if (!token) return res.status(400).json({ error: 'Spotify credentials missing or invalid' });

  const target = Math.max(100, Math.min(parseInt(req.body?.target) || 2000, 5000));
  const reset = !!req.body?.reset;

  // Query mix gives broad coverage while still weighted toward global popularity.
  const seedQueries = [
    'a','b','c','d','e','f','g','h','i','j','k','l','m','n','o','p','q','r','s','t','u','v','w','x','y','z',
    'pop','rock','hip hop','rap','r&b','electronic','metal','jazz','country','latin','k-pop','indie'
  ];
  const offsets = [0, 50, 100, 150];

  const byId = new Map();
  for (const q of seedQueries) {
    for (const off of offsets) {
      const items = await spotifySearchArtists(token, q, off, 50);
      for (const a of items) {
        const followers = a?.followers?.total || 0;
        const popularity = a?.popularity || 0;
        const genres = Array.isArray(a?.genres) ? a.genres : [];
        const existing = byId.get(a.id);
        const row = {
          id: a.id,
          name: a.name || 'Unknown',
          followers,
          popularity,
          genres,
          image_url: a.images?.[1]?.url || a.images?.[0]?.url || null,
          country: null,
          spotify_url: a?.external_urls?.spotify || null,
          fetched_at: new Date().toISOString(),
          primary_genre: genres.map(normalizeGenreTag).find(g => g !== 'other') || 'other',
        };
        if (!existing || (row.followers > existing.followers)) byId.set(a.id, row);
      }
      if (byId.size >= target * 1.4) break;
      await new Promise(r => setTimeout(r, 80));
    }
    if (byId.size >= target * 1.4) break;
  }

  // Rank by followers first, then popularity, and trim to target.
  const ranked = [...byId.values()]
    .sort((a, b) => (b.followers - a.followers) || (b.popularity - a.popularity))
    .slice(0, target);

  const upsertRows = ranked.map(({ primary_genre, ...rest }) => rest);

  if (reset) {
    await supabase.from('cached_artists').delete().neq('id', '');
  }

  const BATCH = 500;
  let saved = 0;
  for (let i = 0; i < upsertRows.length; i += BATCH) {
    const chunk = upsertRows.slice(i, i + BATCH);
    const { error } = await supabase.from('cached_artists').upsert(chunk, { onConflict: 'id' });
    if (error) return res.status(500).json({ error: error.message });
    saved += chunk.length;
  }

  res.json({
    message: `Seeded ${saved} artists`,
    total: saved
  });
});

// GET /api/artists/browse?genre=rock&country=all&sort=followers&page=1&limit=50
app.get('/api/artists/browse', async (req, res) => {
  try {
    const genre = (req.query.genre || 'all').toLowerCase();
    const country = (req.query.country || 'all').toLowerCase();
    const sort = (req.query.sort || 'followers').toLowerCase();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, parseInt(req.query.limit) || 50);
    const offset = (page - 1) * limit;

    // Load full cache (paginated — PostgREST max ~1000 rows per call).
    let allRows;
    try {
      allRows = await supabaseSelectAll('cached_artists', '*');
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }

    const filtered = (allRows || []).filter((r) => {
      if (country !== 'all' && (r.country || '').toLowerCase() !== country) return false;
      if (genre === 'all') return true;
      const tags = Array.isArray(r.genres) ? r.genres : [];
      const normalized = tags.map(normalizeGenreTag);
      return normalized.includes(genre);
    });

    filtered.sort((a, b) => {
      if (sort === 'popularity') return (b.popularity || 0) - (a.popularity || 0);
      return (b.followers || 0) - (a.followers || 0);
    });

    const pageRows = filtered.slice(offset, offset + limit).map((r) => ({
      ...r,
      primary_genre: (Array.isArray(r.genres) ? r.genres.map(normalizeGenreTag).find(g => g !== 'other') : null) || 'other',
    }));

    res.json({
      artists: pageRows,
      total: filtered.length,
      page,
      limit
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to browse artists' });
  }
});

app.get('/api/artists/stats', async (_req, res) => {
  try {
    const rows = await supabaseSelectAll('cached_artists', 'genres');
    const counts = {};
    rows.forEach(r => {
      (r.genres || []).map(normalizeGenreTag).forEach(g => { counts[g] = (counts[g] || 0) + 1; });
    });
    res.json({ total: rows.length, genres: counts });
  } catch {
    res.json({ total: 0, genres: {} });
  }
});



// ════════════════════════════════════════════════════════════════════════════
// HEALTH CHECK
// ════════════════════════════════════════════════════════════════════════════
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '2.0.0', timestamp: new Date().toISOString() });
});

// Main UI — open http://localhost:3001/ (same origin as API_BASE in index.html)
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});


// ════════════════════════════════════════════════════════════════════════════
// START — with graceful port handling
// ════════════════════════════════════════════════════════════════════════════
// env vars are strings — must be numeric or `3001 + 1` becomes `30011` (concat)
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
      startServer(Number(port) + 1);
    } else {
      console.error('Server error:', err);
      process.exit(1);
    }
  });
}

startServer(PORT);
