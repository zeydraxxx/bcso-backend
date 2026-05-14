const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(cors({
  origin: ['https://bcso-zey-deox.netlify.app', 'http://localhost:3000'],
  credentials: true
}));

// ── CONFIG ──────────────────────────────────────────────
const DISCORD_CLIENT_ID     = '1504256148768030800';
const DISCORD_CLIENT_SECRET = 'dVwrMcbCC9OuRFK8rPAb-bncGplKgqE8';
const DISCORD_REDIRECT_URI  = 'https://bcso-backend-production.up.railway.app/auth/callback';
const DISCORD_GUILD_ID      = '1464245148035842060';

// Rôles qui ont accès au panel admin
const DISCORD_ADMIN_ROLES = [
  '1464245148421455953', // Rôle original
  '1504268880447803403', // Sheriff Office
  '1464245148396421182'  // Human Resources
];

const SUPABASE_URL  = 'https://qvtlllgqrxkefwrbmmpj.supabase.co';
const SUPABASE_KEY  = 'sb_secret_C0oEx-SLCC8tfQxYM8sWMw_jd3fH5GG';
const FRONTEND_URL  = 'https://bcso-zey-deox.netlify.app';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── SANITY CHECK ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'BCSO Backend opérationnel ✅' });
});

// ── ÉTAPE 1 : Rediriger vers Discord OAuth ───────────────
app.get('/auth/login', (req, res) => {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds.members.read'
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

// ── ÉTAPE 2 : Discord renvoie un code ici ────────────────
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect(`${FRONTEND_URL}?error=no_code`);

  try {
    const tokenRes = await axios.post('https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: DISCORD_REDIRECT_URI
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const accessToken = tokenRes.data.access_token;

    const userRes = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const user = userRes.data;

    let isAdmin = false;
    try {
      const memberRes = await axios.get(
        `https://discord.com/api/users/@me/guilds/${DISCORD_GUILD_ID}/member`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const memberRoles = memberRes.data.roles || [];
      isAdmin = DISCORD_ADMIN_ROLES.some(role => memberRoles.includes(role));
    } catch (e) {
      isAdmin = false;
    }

    await supabase.from('discord_users').upsert({
      discord_id: user.id,
      username: user.username,
      avatar: user.avatar,
      is_admin: isAdmin,
      last_login: new Date().toISOString()
    }, { onConflict: 'discord_id' });

    const params = new URLSearchParams({
      discord_id: user.id,
      username: user.username,
      avatar: user.avatar || '',
      is_admin: isAdmin ? '1' : '0'
    });

    res.redirect(`${FRONTEND_URL}?${params}`);

  } catch (err) {
    console.error('Auth error:', err.response?.data || err.message);
    res.redirect(`${FRONTEND_URL}?error=auth_failed`);
  }
});

// ── VÉRIFIER SI DÉJÀ CANDIDATÉ ───────────────────────────
app.get('/candidature/check/:discord_id', async (req, res) => {
  const { discord_id } = req.params;
  try {
    const { data, error } = await supabase
      .from('candidatures')
      .select('id, status')
      .eq('discord_id', discord_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('Check error:', error);
      return res.json({ exists: false, status: null });
    }
    res.json({ exists: !!data, status: data?.status || null });
  } catch (err) {
    console.error('Check error:', err.message);
    res.json({ exists: false, status: null });
  }
});

// ── SOUMETTRE UNE CANDIDATURE ────────────────────────────
app.post('/candidature', async (req, res) => {
  const { discord_id, username, nom, prenom, age, heures, horaire, experience, unite, motivation } = req.body;

  if (!discord_id || !nom || !prenom || !age || !motivation) {
    return res.status(400).json({ error: 'Champs manquants' });
  }

  const { data: existing } = await supabase
    .from('candidatures')
    .select('id, status')
    .eq('discord_id', discord_id)
    .in('status', ['pending', 'accepted'])
    .maybeSingle();

  if (existing) {
    return res.status(409).json({
      error: existing.status === 'accepted'
        ? 'Tu es déjà membre du BCSO !'
        : 'Tu as déjà une candidature en attente.'
    });
  }

  const { data, error } = await supabase.from('candidatures').insert({
    discord_id, username, nom, prenom,
    age: parseInt(age),
    heures: parseInt(heures),
    horaire, experience, unite, motivation,
    status: 'pending',
    created_at: new Date().toISOString()
  }).select().single();

  if (error) {
    console.error('Insert error:', error);
    return res.status(500).json({ error: 'Erreur base de données' });
  }

  res.json({ success: true, id: data.id });
});

// ── RÉCUPÉRER TOUTES LES CANDIDATURES (admin) ────────────
app.get('/candidatures', async (req, res) => {
  const { discord_id } = req.query;
  if (!discord_id) return res.status(401).json({ error: 'Non autorisé' });

  const { data: user } = await supabase
    .from('discord_users')
    .select('is_admin')
    .eq('discord_id', discord_id)
    .maybeSingle();

  if (!user?.is_admin) return res.status(403).json({ error: 'Accès refusé' });

  const { data, error } = await supabase
    .from('candidatures')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: 'Erreur BDD' });
  res.json(data);
});

// ── METTRE À JOUR LE STATUT (admin) ──────────────────────
app.patch('/candidature/:id', async (req, res) => {
  const { discord_id, status } = req.body;
  const { id } = req.params;

  if (!['pending', 'accepted', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Statut invalide' });
  }

  const { data: user } = await supabase
    .from('discord_users')
    .select('is_admin')
    .eq('discord_id', discord_id)
    .maybeSingle();

  if (!user?.is_admin) return res.status(403).json({ error: 'Accès refusé' });

  const { error } = await supabase
    .from('candidatures')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) return res.status(500).json({ error: 'Erreur BDD' });
  res.json({ success: true });
});

// ── SUPPRIMER UNE CANDIDATURE (admin) ────────────────────
app.delete('/candidature/:id', async (req, res) => {
  const { discord_id } = req.body;
  const { id } = req.params;

  const { data: user } = await supabase
    .from('discord_users')
    .select('is_admin')
    .eq('discord_id', discord_id)
    .maybeSingle();

  if (!user?.is_admin) return res.status(403).json({ error: 'Accès refusé' });

  const { error } = await supabase
    .from('candidatures')
    .delete()
    .eq('id', id);

  if (error) return res.status(500).json({ error: 'Erreur BDD' });
  res.json({ success: true });
});

// ── START ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`BCSO Backend lancé sur le port ${PORT}`));
