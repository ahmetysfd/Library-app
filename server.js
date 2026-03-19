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

const path    = require('path');
const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');
const jwt    = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));

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
// HEALTH CHECK
// ════════════════════════════════════════════════════════════════════════════
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '2.0.0', timestamp: new Date().toISOString() });
});

// Serve index.html + static assets from project folder (same origin as API)
app.use(express.static(path.join(__dirname), { index: 'index.html' }));

// ════════════════════════════════════════════════════════════════════════════
// START
// ════════════════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n  ┌──────────────────────────────────────────────────────────┐`);
  console.log(`  │  SHELF running on port ${PORT}                              │`);
  console.log(`  │  App (open in browser):  http://localhost:${PORT}/          │`);
  console.log(`  │  API health check:       http://localhost:${PORT}/api/health │`);
  console.log(`  └──────────────────────────────────────────────────────────┘\n`);
});
