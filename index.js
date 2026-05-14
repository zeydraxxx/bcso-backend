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

const DISCORD_ADMIN_ROLES = {
  '1464245148421455953': 'Commandement',
  '1504268880447803403': 'Sheriff Office',
  '1464245148396421182': 'Human Resources'
};

const SUPABASE_URL = 'https://qvtlllgqrxkefwrbmmpj.supabase.co';
const SUPABASE_KEY = 'sb_secret_C0oEx-SLCC8tfQxYM8sWMw_jd3fH5GG';
const FRONTEND_URL = 'https://bcso-zey-deox.netlify.app';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── SANITY CHECK ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'BCSO Backend opérationnel ✅' });
});

// ── AUTH LOGIN ────────────────────────────────────────────
app.get('/auth/login', (req, res) => {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds.members.read'
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

// ── AUTH CALLBACK ─────────────────────────────────────────
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
    let roleName = '';

    try {
      const memberRes = await axios.get(
        `https://discord.com/api/users/@me/guilds/${DISCORD_GUILD_ID}/member`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const memberRoles = memberRes.data.roles || [];

      // Trouver le rôle admin le plus élevé
      for (const [roleId, name] of Object.entries(DISCORD_ADMIN_ROLES)) {
        if (memberRoles.includes(roleId)) {
          isAdmin = true;
          roleName = name;
          break;
        }
      }
    } catch (e) {
      isAdmin = false;
    }

    await supabase.from('discord_users').upsert({
      discord_id: user.id,
      username: user.username,
      avatar: user.avatar,
      is_admin: isAdmin,
      role_name: roleName,
      last_login: new Date().toISOString()
    }, { onConflict: 'discord_id' });

    const params = new URLSearchParams({
      discord_id: user.id,
      username: user.username,
      avatar: user.avatar || '',
      is_admin: isAdmin ? '1' : '0',
      role_name: roleName
    });

    res.redirect(`${FRONTEND_URL}?${params}`);

  } catch (err) {
    console.error('Auth error:', err.response?.data || err.message);
    res.redirect(`${FRONTEND_URL}?error=auth_failed`);
  }
});

// ── CHECK CANDIDATURE ─────────────────────────────────────
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

    if (error) return res.json({ exists: false, status: null });
    res.json({ exists: !!data, status: data?.status || null });
  } catch (err) {
    res.json({ exists: false, status: null });
  }
});

// ── SOUMETTRE CANDIDATURE ─────────────────────────────────
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
    discord_id,
    username,
    nom,
    prenom,
    age: parseInt(age),
    heures: parseInt(heures),
    horaire,
    experience,
    unite,
    motivation,
    status: 'pending',
    notes: '',
    votes_yes: 0,
    votes_no: 0,
    vote_fin: false,
    created_at: new Date().toISOString()
  }).select().single();

  if (error) {
    console.error('Insert error:', error);
    return res.status(500).json({ error: 'Erreur base de données' });
  }

  res.json({ success: true, id: data.id });
});

// ── RÉCUPÉRER TOUTES LES CANDIDATURES (admin) ─────────────
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

  // Pour chaque candidature, récupérer les votes individuels
  const withVotes = await Promise.all(data.map(async (c) => {
    const { data: votes } = await supabase
      .from('candidature_votes')
      .select('discord_id, username, vote')
      .eq('candidature_id', c.id);
    return { ...c, vote_details: votes || [] };
  }));

  res.json(withVotes);
});

// ── VOTER POUR UNE CANDIDATURE (admin) ────────────────────
app.post('/candidature/:id/vote', async (req, res) => {
  const { discord_id, username, vote } = req.body;
  const { id } = req.params;

  if (!['yes', 'no'].includes(vote)) {
    return res.status(400).json({ error: 'Vote invalide' });
  }

  const { data: user } = await supabase
    .from('discord_users')
    .select('is_admin')
    .eq('discord_id', discord_id)
    .maybeSingle();

  if (!user?.is_admin) return res.status(403).json({ error: 'Accès refusé' });

  // Vérifier que le vote n'est pas terminé
  const { data: cand } = await supabase
    .from('candidatures')
    .select('vote_fin')
    .eq('id', id)
    .single();

  if (cand?.vote_fin) {
    return res.status(400).json({ error: 'Le vote est terminé pour cette candidature' });
  }

  // Upsert du vote (remplace si déjà voté)
  const { error: voteError } = await supabase
    .from('candidature_votes')
    .upsert({
      candidature_id: id,
      discord_id,
      username,
      vote,
      created_at: new Date().toISOString()
    }, { onConflict: 'candidature_id,discord_id' });

  if (voteError) {
    console.error('Vote error:', voteError);
    return res.status(500).json({ error: 'Erreur lors du vote' });
  }

  // Recalculer les compteurs
  const { data: allVotes } = await supabase
    .from('candidature_votes')
    .select('vote')
    .eq('candidature_id', id);

  const votes_yes = allVotes.filter(v => v.vote === 'yes').length;
  const votes_no  = allVotes.filter(v => v.vote === 'no').length;

  await supabase
    .from('candidatures')
    .update({ votes_yes, votes_no })
    .eq('id', id);

  res.json({ success: true, votes_yes, votes_no });
});

// ── CLÔTURER LE VOTE (admin) ──────────────────────────────
app.post('/candidature/:id/cloture', async (req, res) => {
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
    .update({ vote_fin: true })
    .eq('id', id);

  if (error) return res.status(500).json({ error: 'Erreur BDD' });
  res.json({ success: true });
});

// ── METTRE À JOUR STATUT (admin) ──────────────────────────
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

// ── METTRE À JOUR LES NOTES (admin) ───────────────────────
app.patch('/candidature/:id/notes', async (req, res) => {
  const { discord_id, notes } = req.body;
  const { id } = req.params;

  const { data: user } = await supabase
    .from('discord_users')
    .select('is_admin')
    .eq('discord_id', discord_id)
    .maybeSingle();

  if (!user?.is_admin) return res.status(403).json({ error: 'Accès refusé' });

  const { error } = await supabase
    .from('candidatures')
    .update({ notes, updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) return res.status(500).json({ error: 'Erreur BDD' });
  res.json({ success: true });
});

// ── SUPPRIMER CANDIDATURE (admin) ─────────────────────────
app.delete('/candidature/:id', async (req, res) => {
  const { discord_id } = req.body;
  const { id } = req.params;

  const { data: user } = await supabase
    .from('discord_users')
    .select('is_admin')
    .eq('discord_id', discord_id)
    .maybeSingle();

  if (!user?.is_admin) return res.status(403).json({ error: 'Accès refusé' });

  // Supprimer aussi les votes liés
  await supabase.from('candidature_votes').delete().eq('candidature_id', id);
  const { error } = await supabase.from('candidatures').delete().eq('id', id);

  if (error) return res.status(500).json({ error: 'Erreur BDD' });
  res.json({ success: true });
});

// ── START ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`BCSO Backend lancé sur le port ${PORT}`));
