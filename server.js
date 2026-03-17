/**
 * SHELF — Backend API Server
 * Stack: Node.js + Express + Supabase (PostgreSQL)
 * 
 * Run: npm install && node server.js
 * Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, JWT_SECRET, PORT
 */

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── Auth Middleware ───────────────────────────────────────────────────────────
const auth = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// ─── Auth Routes ───────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { username, email, password } = req.body;
  const hash = await bcrypt.hash(password, 10);
  const { data, error } = await supabase
    .from('users')
    .insert({ username, email, password_hash: hash })
    .select('id, username, email, created_at')
    .single();
  if (error) return res.status(400).json({ error: error.message });
  const token = jwt.sign({ id: data.id, username: data.username }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.json({ user: data, token });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const { data: user } = await supabase
    .from('users')
    .select('*')
    .eq('email', email)
    .single();
  if (!user || !(await bcrypt.compare(password, user.password_hash)))
    return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET, { expiresIn: '30d' });
  const { password_hash, ...safeUser } = user;
  res.json({ user: safeUser, token });
});

// ─── Library Routes ────────────────────────────────────────────────────────────
// GET /api/libraries — get current user's libraries
app.get('/api/libraries', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('libraries')
    .select('*, items:library_items(count)')
    .eq('user_id', req.user.id)
    .order('created_at');
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// GET /api/users/:username/libraries — public profile
app.get('/api/users/:username/libraries', async (req, res) => {
  const { data: user } = await supabase
    .from('users')
    .select('id, username, avatar_url, bio')
    .eq('username', req.params.username)
    .single();
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { data: libraries } = await supabase
    .from('libraries')
    .select('*, items:library_items(count)')
    .eq('user_id', user.id)
    .eq('is_public', true)
    .order('created_at');
  res.json({ user, libraries });
});

// POST /api/libraries — create a library (max 1 per type per user)
app.post('/api/libraries', auth, async (req, res) => {
  const { type } = req.body; // 'books' | 'films' | 'music' | 'games'
  const VALID_TYPES = ['books', 'films', 'music', 'games'];
  if (!VALID_TYPES.includes(type))
    return res.status(400).json({ error: 'Invalid library type' });

  // Enforce: 1 per type per user
  const { data: existing } = await supabase
    .from('libraries')
    .select('id')
    .eq('user_id', req.user.id)
    .eq('type', type)
    .single();
  if (existing)
    return res.status(409).json({ error: `You already have a ${type} library` });

  const { data, error } = await supabase
    .from('libraries')
    .insert({ user_id: req.user.id, type, is_public: true })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// DELETE /api/libraries/:id
app.delete('/api/libraries/:id', auth, async (req, res) => {
  const { error } = await supabase
    .from('libraries')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

// ─── Library Items ─────────────────────────────────────────────────────────────
// GET /api/libraries/:id/items
app.get('/api/libraries/:id/items', auth, async (req, res) => {
  const { page = 1, limit = 50, sort = 'created_at' } = req.query;
  const from = (page - 1) * limit;
  const { data, error, count } = await supabase
    .from('library_items')
    .select('*', { count: 'exact' })
    .eq('library_id', req.params.id)
    .order(sort, { ascending: false })
    .range(from, from + limit - 1);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ items: data, total: count, page: Number(page) });
});

// POST /api/libraries/:id/items
app.post('/api/libraries/:id/items', auth, async (req, res) => {
  // Verify ownership
  const { data: lib } = await supabase
    .from('libraries')
    .select('user_id')
    .eq('id', req.params.id)
    .single();
  if (!lib || lib.user_id !== req.user.id)
    return res.status(403).json({ error: 'Forbidden' });

  const { title, subtitle, year, cover_color, rating, status, metadata } = req.body;
  const { data, error } = await supabase
    .from('library_items')
    .insert({
      library_id: req.params.id,
      title, subtitle, year, cover_color,
      rating, status, metadata
    })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// PATCH /api/libraries/:libraryId/items/:itemId
app.patch('/api/libraries/:libraryId/items/:itemId', auth, async (req, res) => {
  const { data: lib } = await supabase
    .from('libraries')
    .select('user_id')
    .eq('id', req.params.libraryId)
    .single();
  if (!lib || lib.user_id !== req.user.id)
    return res.status(403).json({ error: 'Forbidden' });

  const { data, error } = await supabase
    .from('library_items')
    .update(req.body)
    .eq('id', req.params.itemId)
    .eq('library_id', req.params.libraryId)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// DELETE /api/libraries/:libraryId/items/:itemId
app.delete('/api/libraries/:libraryId/items/:itemId', auth, async (req, res) => {
  const { data: lib } = await supabase
    .from('libraries')
    .select('user_id')
    .eq('id', req.params.libraryId)
    .single();
  if (!lib || lib.user_id !== req.user.id)
    return res.status(403).json({ error: 'Forbidden' });
  await supabase.from('library_items').delete().eq('id', req.params.itemId);
  res.json({ success: true });
});

// ─── Social: Follow ────────────────────────────────────────────────────────────
app.post('/api/users/:id/follow', auth, async (req, res) => {
  if (req.params.id === req.user.id)
    return res.status(400).json({ error: 'Cannot follow yourself' });
  const { error } = await supabase
    .from('follows')
    .upsert({ follower_id: req.user.id, following_id: req.params.id });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

app.delete('/api/users/:id/follow', auth, async (req, res) => {
  await supabase.from('follows')
    .delete()
    .eq('follower_id', req.user.id)
    .eq('following_id', req.params.id);
  res.json({ success: true });
});

// ─── Activity Feed ─────────────────────────────────────────────────────────────
// GET /api/feed — items added by people you follow
app.get('/api/feed', auth, async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const from = (page - 1) * limit;
  const { data, error } = await supabase
    .from('activity_feed')
    .select('*')
    .eq('viewer_id', req.user.id)
    .order('created_at', { ascending: false })
    .range(from, from + limit - 1);
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// ─── Search ────────────────────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const { q, type } = req.query;
  if (!q) return res.json({ users: [], items: [] });

  const [{ data: users }, { data: items }] = await Promise.all([
    supabase.from('users')
      .select('id, username, avatar_url')
      .ilike('username', `%${q}%`)
      .limit(10),
    supabase.from('library_items')
      .select('id, title, subtitle, year, libraries(type)')
      .ilike('title', `%${q}%`)
      .limit(20)
  ]);
  res.json({ users, items });
});

app.listen(process.env.PORT || 3001, () =>
  console.log(`Shelf API running on :${process.env.PORT || 3001}`)
);
