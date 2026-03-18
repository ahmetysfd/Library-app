/**
 * SHELF — Backend API + Metadata Proxy Server
 * Stack: Node.js + Express + Supabase
 * Run: npm install && node server.js
 */

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');
const jwt    = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const auth = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
};

// Auth
app.post('/api/auth/register', async (req, res) => {
  const { username, email, password } = req.body;
  const hash = await bcrypt.hash(password, 10);
  const { data, error } = await supabase.from('users').insert({ username, email, password_hash: hash }).select('id,username,email').single();
  if (error) return res.status(400).json({ error: error.message });
  const token = jwt.sign({ id: data.id, username: data.username }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.json({ user: data, token });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
  if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET, { expiresIn: '30d' });
  const { password_hash, ...safe } = user;
  res.json({ user: safe, token });
});

// Libraries - 1 per type enforced
app.get('/api/libraries', auth, async (req, res) => {
  const { data, error } = await supabase.from('libraries').select('*,items:library_items(count)').eq('user_id', req.user.id).order('created_at');
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});
app.post('/api/libraries', auth, async (req, res) => {
  const { type } = req.body;
  if (!['books','films','music','games'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
  const { data: ex } = await supabase.from('libraries').select('id').eq('user_id', req.user.id).eq('type', type).single();
  if (ex) return res.status(409).json({ error: `You already have a ${type} library` });
  const { data, error } = await supabase.from('libraries').insert({ user_id: req.user.id, type }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});
app.delete('/api/libraries/:id', auth, async (req, res) => {
  await supabase.from('libraries').delete().eq('id', req.params.id).eq('user_id', req.user.id);
  res.json({ success: true });
});

// Items
app.get('/api/libraries/:id/items', auth, async (req, res) => {
  const { page=1, limit=50 } = req.query;
  const from = (page-1)*limit;
  const { data, count, error } = await supabase.from('library_items').select('*',{count:'exact'}).eq('library_id',req.params.id).order('created_at',{ascending:false}).range(from,from+limit-1);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ items:data, total:count, page:Number(page) });
});
app.post('/api/libraries/:id/items', auth, async (req, res) => {
  const { data:lib } = await supabase.from('libraries').select('user_id').eq('id',req.params.id).single();
  if (!lib||lib.user_id!==req.user.id) return res.status(403).json({ error:'Forbidden' });
  const { ext_id,title,subtitle,cover_url,status,metadata } = req.body;
  const { data, error } = await supabase.from('library_items').insert({ library_id:req.params.id,ext_id,title,subtitle,cover_url,status,metadata }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});
app.delete('/api/libraries/:lid/items/:iid', auth, async (req, res) => {
  const { data:lib } = await supabase.from('libraries').select('user_id').eq('id',req.params.lid).single();
  if (!lib||lib.user_id!==req.user.id) return res.status(403).json({error:'Forbidden'});
  await supabase.from('library_items').delete().eq('id',req.params.iid);
  res.json({ success:true });
});

// ── METADATA SEARCH PROXIES ────────────────────────────────────────────────────

// FILMS via TMDB — https://www.themoviedb.org/settings/api (free, instant)
app.get('/api/search/films', async (req, res) => {
  const key = process.env.TMDB_API_KEY;
  if (!key) return res.status(503).json({ error: 'TMDB_API_KEY not set' });
  const r = await fetch(`https://api.themoviedb.org/3/search/multi?api_key=${key}&query=${encodeURIComponent(req.query.q)}&include_adult=false`);
  const d = await r.json();
  res.json((d.results||[]).filter(x=>x.poster_path).slice(0,16).map(x=>({
    ext_id: String(x.id), title: x.title||x.name,
    subtitle: (x.release_date||x.first_air_date||'').slice(0,4),
    cover_url: `https://image.tmdb.org/t/p/w185${x.poster_path}`,
    metadata: { media_type:x.media_type, vote_average:x.vote_average }
  })));
});

// BOOKS via Open Library — free, no key
app.get('/api/search/books', async (req, res) => {
  const r = await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(req.query.q)}&limit=16&fields=key,title,author_name,cover_i,first_publish_year`);
  const d = await r.json();
  res.json((d.docs||[]).filter(x=>x.cover_i).slice(0,16).map(x=>({
    ext_id: x.key, title: x.title,
    subtitle: (x.author_name||[])[0]||'',
    cover_url: `https://covers.openlibrary.org/b/id/${x.cover_i}-M.jpg`,
    metadata: { year:x.first_publish_year }
  })));
});

// MUSIC via MusicBrainz + Cover Art Archive — free, no key
app.get('/api/search/music', async (req, res) => {
  const r = await fetch(
    `https://musicbrainz.org/ws/2/release/?query=release:${encodeURIComponent(req.query.q)}&limit=16&fmt=json`,
    { headers:{'User-Agent':'ShelfApp/1.0 (contact@shelf.app)'} }
  );
  const d = await r.json();
  res.json((d.releases||[]).slice(0,16).map(rel=>({
    ext_id: rel.id, title: rel.title,
    subtitle: (rel['artist-credit']||[]).map(a=>a.name||a?.artist?.name).filter(Boolean).join(', '),
    cover_url: `https://coverartarchive.org/release/${rel.id}/front-250`,
    metadata: { date:rel.date }
  })));
});

// GAMES via IGDB (Twitch) — free, get key at dev.twitch.tv/console
// Token expires every 60 days — refresh: POST https://id.twitch.tv/oauth2/token
app.get('/api/search/games', async (req, res) => {
  const clientId = process.env.IGDB_CLIENT_ID;
  const token    = process.env.IGDB_ACCESS_TOKEN;
  if (!clientId||!token) return res.status(503).json({ error: 'IGDB credentials not set' });
  const body = `search "${req.query.q}"; fields name,cover.url,first_release_date,platforms.abbreviation,genres.name,rating; limit 16; where cover != null;`;
  const r = await fetch('https://api.igdb.com/v4/games', {
    method:'POST',
    headers:{'Client-ID':clientId,'Authorization':`Bearer ${token}`,'Content-Type':'text/plain'},
    body
  });
  const games = await r.json();
  res.json((games||[]).map(g=>({
    ext_id: String(g.id), title: g.name,
    subtitle: (g.platforms||[]).map(p=>p.abbreviation).slice(0,2).join('/'),
    cover_url: g.cover?.url?.replace('t_thumb','t_cover_big').replace('//', 'https://'),
    metadata: { igdb_id:g.id, genres:(g.genres||[]).map(x=>x.name), rating:g.rating?Math.round(g.rating):null, year:g.first_release_date?new Date(g.first_release_date*1000).getFullYear():null }
  })));
});

// Social
app.post('/api/users/:id/follow', auth, async (req,res)=>{
  if(req.params.id===req.user.id) return res.status(400).json({error:'Cannot follow yourself'});
  await supabase.from('follows').upsert({follower_id:req.user.id,following_id:req.params.id});
  res.json({success:true});
});
app.delete('/api/users/:id/follow', auth, async (req,res)=>{
  await supabase.from('follows').delete().eq('follower_id',req.user.id).eq('following_id',req.params.id);
  res.json({success:true});
});
app.get('/api/feed', auth, async (req,res)=>{
  const {page=1,limit=20}=req.query; const from=(page-1)*limit;
  const {data,error}=await supabase.from('activity_feed').select('*').eq('viewer_id',req.user.id).order('created_at',{ascending:false}).range(from,from+limit-1);
  if(error) return res.status(400).json({error:error.message});
  res.json(data);
});
app.get('/api/users/:username', async (req,res)=>{
  const {data:user}=await supabase.from('users').select('id,username,avatar_url,bio').eq('username',req.params.username).single();
  if(!user) return res.status(404).json({error:'Not found'});
  const {data:libraries}=await supabase.from('libraries').select('*,items:library_items(count)').eq('user_id',user.id).eq('is_public',true);
  const {data:stats}=await supabase.from('user_stats').select('*').eq('id',user.id).single();
  res.json({user,libraries,stats});
});
app.get('/api/search', async (req,res)=>{
  const {q}=req.query; if(!q) return res.json({users:[],items:[]});
  const [{data:users},{data:items}]=await Promise.all([
    supabase.from('users').select('id,username,avatar_url').ilike('username',`%${q}%`).limit(10),
    supabase.from('library_items').select('id,title,subtitle,libraries(type)').ilike('title',`%${q}%`).limit(20)
  ]);
  res.json({users,items});
});

app.listen(process.env.PORT||3001,()=>console.log(`Shelf API :${process.env.PORT||3001}`));
