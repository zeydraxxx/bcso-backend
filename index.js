const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(cors({
  origin: [
    'https://sheriff-academy.netlify.app',
    'https://bcso-zey-deox.netlify.app',
    'http://localhost:3000'
  ],
  credentials: true
}));

// ── CONFIG (variables d'environnement Railway) ───────────
const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID     || '1504256148768030800';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const DISCORD_REDIRECT_URI  = 'https://bcso-backend-production.up.railway.app/auth/callback';

// Serveur BCSO admin
const DISCORD_GUILD_ID    = '1464245148035842060';
const DISCORD_ADMIN_ROLES = {
  '1504268880447803403': 'Sheriff Office',
  '1464245148396421182': 'Human Resources'
};

// Serveur candidature
const DISCORD_CAND_GUILD_ID = '1503182444067557508';
const DISCORD_CAND_ROLE     = '1503182444067557509'; // Citoyen = requis pour candidater
const DISCORD_REFUSE_1      = '1504421729345343559';
const DISCORD_REFUSE_2      = '1504421833112424510';
const DISCORD_REFUSE_PERM   = '1504421845716303993';

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const SUPABASE_URL        = 'https://qvtlllgqrxkefwrbmmpj.supabase.co';
const SUPABASE_KEY        = process.env.SUPABASE_KEY || '';
const FRONTEND_URL        = 'https://sheriff-academy.netlify.app';

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
    scope: 'identify guilds guilds.members.read'
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

    // Vérifier BL
    const { data: blEntry } = await supabase
      .from('blacklist').select('reason').eq('discord_id', user.id).maybeSingle();
    if (blEntry) {
      return res.redirect(`${FRONTEND_URL}?error=blacklisted&reason=${encodeURIComponent(blEntry.reason || 'Aucune raison fournie')}`);
    }

    // Récupérer toutes les guilds
    let userGuilds = [];
    try {
      const guildsRes = await axios.get('https://discord.com/api/users/@me/guilds', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      userGuilds = guildsRes.data.map(g => g.id);
    } catch {}

    // Vérifier rôles admin BCSO
    let isAdmin = false;
    let roleName = '';
    try {
      const memberRes = await axios.get(
        `https://discord.com/api/users/@me/guilds/${DISCORD_GUILD_ID}/member`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const memberRoles = memberRes.data.roles || [];
      for (const [roleId, name] of Object.entries(DISCORD_ADMIN_ROLES)) {
        if (memberRoles.includes(roleId)) { isAdmin = true; roleName = name; break; }
      }
    } catch {}

    // Vérifier serveur candidature
    let candStatus = 'not_in_server';
    let candRefuseCount = 0;
    const inCandServer = userGuilds.includes(DISCORD_CAND_GUILD_ID);

    if (inCandServer) {
      try {
        const candMemberRes = await axios.get(
          `https://discord.com/api/users/@me/guilds/${DISCORD_CAND_GUILD_ID}/member`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const candRoles = candMemberRes.data.roles || [];
        if (candRoles.includes(DISCORD_REFUSE_PERM)) {
          candStatus = 'refused_perm'; candRefuseCount = 3;
        } else if (candRoles.includes(DISCORD_REFUSE_2)) {
          candStatus = 'refused_2'; candRefuseCount = 2;
        } else if (candRoles.includes(DISCORD_REFUSE_1)) {
          candStatus = 'refused_1'; candRefuseCount = 1;
        } else if (candRoles.includes(DISCORD_CAND_ROLE)) {
          candStatus = 'ok';
        } else {
          candStatus = 'no_role';
        }
      } catch { candStatus = 'no_role'; }
    }

    // Admins bypass vérification candidature
    if (isAdmin) candStatus = 'ok';

    await supabase.from('discord_users').upsert({
      discord_id: user.id,
      username: user.username,
      avatar: user.avatar,
      is_admin: isAdmin,
      role_name: roleName,
      cand_status: candStatus,
      cand_refuse_count: candRefuseCount,
      last_login: new Date().toISOString()
    }, { onConflict: 'discord_id' });

    const params = new URLSearchParams({
      discord_id: user.id,
      username: user.username,
      avatar: user.avatar || '',
      is_admin: isAdmin ? '1' : '0',
      role_name: roleName,
      cand_status: candStatus,
      cand_refuse_count: String(candRefuseCount)
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
    const { data } = await supabase
      .from('candidatures')
      .select('id, status')
      .eq('discord_id', discord_id)
      .in('status', ['pending', 'accepted'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    res.json({ exists: !!data, status: data?.status || null });
  } catch { res.json({ exists: false, status: null }); }
});

// ── SOUMETTRE CANDIDATURE ─────────────────────────────────
app.post('/candidature', async (req, res) => {
  const {
    discord_id, username, nom, prenom, age, heures, horaire,
    unite, motivation, permis, permis_types, permis_arme,
    antecedent, antecedent_details, qcm_score, qcm_total
  } = req.body;

  if (!discord_id || !nom || !prenom || !age || !motivation)
    return res.status(400).json({ error: 'Champs manquants' });

  const { data: bl } = await supabase.from('blacklist').select('reason').eq('discord_id', discord_id).maybeSingle();
  if (bl) return res.status(403).json({ error: 'Vous êtes blacklisté du BCSO.' });

  const { data: existing } = await supabase
    .from('candidatures').select('id, status')
    .eq('discord_id', discord_id).in('status', ['pending', 'accepted']).maybeSingle();
  if (existing) return res.status(409).json({
    error: existing.status === 'accepted' ? 'Tu es déjà membre du BCSO !' : 'Tu as déjà une candidature en attente.'
  });

  const { data, error } = await supabase.from('candidatures').insert({
    discord_id, username, nom, prenom,
    age: parseInt(age), heures: parseInt(heures),
    horaire, unite, motivation,
    permis: permis || false,
    permis_types: permis_types || '',
    permis_arme: permis_arme || false,
    antecedent: antecedent || false,
    antecedent_details: antecedent_details || '',
    qcm_score: qcm_score || 0,
    qcm_total: qcm_total || 15,
    status: 'pending', notes: '', votes_yes: 0, votes_no: 0, vote_fin: false,
    created_at: new Date().toISOString()
  }).select().single();

  if (error) { console.error(error); return res.status(500).json({ error: 'Erreur base de données' }); }

  // Webhook Discord
  if (DISCORD_WEBHOOK_URL) {
    try {
      const qcmPct = qcm_total > 0 ? Math.round((qcm_score / qcm_total) * 100) : 0;
      const qcmEmoji = qcmPct >= 80 ? '🟢' : qcmPct >= 60 ? '🟡' : '🔴';
      await axios.post(DISCORD_WEBHOOK_URL, {
        embeds: [{
          title: '📋 Nouvelle candidature — BCSO Sheriff Academy',
          color: 0xC9A84C,
          fields: [
            { name: '👤 Candidat', value: `**${prenom} ${nom}**`, inline: true },
            { name: '🎮 Discord', value: `${username}\n\`${discord_id}\``, inline: true },
            { name: '🎯 Unité', value: unite, inline: true },
            { name: '🎂 Âge RP', value: `${age} ans`, inline: true },
            { name: '⏱️ Heures/sem', value: `${heures}h`, inline: true },
            { name: '🕐 Horaire', value: horaire, inline: true },
            { name: '🚗 Permis', value: permis ? (permis_types || 'Oui') : 'Non', inline: true },
            { name: '🔫 Permis arme', value: permis_arme ? 'Oui' : 'Non', inline: true },
            { name: '⚖️ Antécédents', value: antecedent ? `Oui — ${antecedent_details || '?'}` : 'Non', inline: true },
            { name: `${qcmEmoji} QCM Règlement`, value: `**${qcm_score}/${qcm_total}** (${qcmPct}%)`, inline: true },
            { name: '📝 Motivation', value: (motivation || '').substring(0, 500) + ((motivation || '').length > 500 ? '...' : '') }
          ],
          footer: { text: '🌐 Panel admin → sheriff-academy.netlify.app' },
          timestamp: new Date().toISOString()
        }]
      });
    } catch (e) { console.error('Webhook error:', e.message); }
  }

  res.json({ success: true, id: data.id });
});

// ── RÉCUPÉRER TOUTES LES CANDIDATURES (admin) ─────────────
app.get('/candidatures', async (req, res) => {
  const { discord_id } = req.query;
  const { data: user } = await supabase.from('discord_users').select('is_admin').eq('discord_id', discord_id).maybeSingle();
  if (!user?.is_admin) return res.status(403).json({ error: 'Accès refusé' });

  const { data, error } = await supabase.from('candidatures').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'Erreur BDD' });

  const withDetails = await Promise.all(data.map(async (c) => {
    const { data: votes } = await supabase.from('candidature_votes').select('discord_id, username, vote').eq('candidature_id', c.id);
    const { data: history } = await supabase.from('candidatures')
      .select('id, status, created_at, votes_yes, votes_no, notes, unite, qcm_score, qcm_total')
      .eq('discord_id', c.discord_id).order('created_at', { ascending: false });
    return { ...c, vote_details: votes || [], history: (history || []).filter(h => h.id !== c.id) };
  }));

  res.json(withDetails);
});

// ── AUTO-SAVE NOTES ───────────────────────────────────────
app.patch('/candidature/:id/notes', async (req, res) => {
  const { discord_id, notes } = req.body;
  const { data: user } = await supabase.from('discord_users').select('is_admin').eq('discord_id', discord_id).maybeSingle();
  if (!user?.is_admin) return res.status(403).json({ error: 'Accès refusé' });
  await supabase.from('candidatures').update({ notes, updated_at: new Date().toISOString() }).eq('id', req.params.id);
  res.json({ success: true });
});

// ── VOTER ─────────────────────────────────────────────────
app.post('/candidature/:id/vote', async (req, res) => {
  const { discord_id, username, vote } = req.body;
  const { id } = req.params;
  if (!['yes', 'no'].includes(vote)) return res.status(400).json({ error: 'Vote invalide' });
  const { data: user } = await supabase.from('discord_users').select('is_admin').eq('discord_id', discord_id).maybeSingle();
  if (!user?.is_admin) return res.status(403).json({ error: 'Accès refusé' });
  const { data: cand } = await supabase.from('candidatures').select('vote_fin').eq('id', id).single();
  if (cand?.vote_fin) return res.status(400).json({ error: 'Vote clôturé' });
  await supabase.from('candidature_votes').upsert(
    { candidature_id: id, discord_id, username, vote, created_at: new Date().toISOString() },
    { onConflict: 'candidature_id,discord_id' }
  );
  const { data: allVotes } = await supabase.from('candidature_votes').select('vote').eq('candidature_id', id);
  const votes_yes = allVotes.filter(v => v.vote === 'yes').length;
  const votes_no  = allVotes.filter(v => v.vote === 'no').length;
  await supabase.from('candidatures').update({ votes_yes, votes_no }).eq('id', id);
  res.json({ success: true, votes_yes, votes_no });
});

// ── CLÔTURER VOTE ─────────────────────────────────────────
app.post('/candidature/:id/cloture', async (req, res) => {
  const { discord_id } = req.body;
  const { data: user } = await supabase.from('discord_users').select('is_admin').eq('discord_id', discord_id).maybeSingle();
  if (!user?.is_admin) return res.status(403).json({ error: 'Accès refusé' });
  await supabase.from('candidatures').update({ vote_fin: true }).eq('id', req.params.id);
  res.json({ success: true });
});

// ── STATUT ────────────────────────────────────────────────
app.patch('/candidature/:id', async (req, res) => {
  const { discord_id, status } = req.body;
  if (!['pending', 'accepted', 'rejected'].includes(status)) return res.status(400).json({ error: 'Invalide' });
  const { data: user } = await supabase.from('discord_users').select('is_admin').eq('discord_id', discord_id).maybeSingle();
  if (!user?.is_admin) return res.status(403).json({ error: 'Accès refusé' });
  await supabase.from('candidatures').update({ status, updated_at: new Date().toISOString() }).eq('id', req.params.id);
  res.json({ success: true });
});

// ── SUPPRIMER ─────────────────────────────────────────────
app.delete('/candidature/:id', async (req, res) => {
  const { discord_id } = req.body;
  const { data: user } = await supabase.from('discord_users').select('is_admin').eq('discord_id', discord_id).maybeSingle();
  if (!user?.is_admin) return res.status(403).json({ error: 'Accès refusé' });
  await supabase.from('candidature_votes').delete().eq('candidature_id', req.params.id);
  await supabase.from('candidatures').delete().eq('id', req.params.id);
  res.json({ success: true });
});

// ── BLACKLIST ─────────────────────────────────────────────
app.get('/blacklist', async (req, res) => {
  const { discord_id } = req.query;
  const { data: user } = await supabase.from('discord_users').select('is_admin').eq('discord_id', discord_id).maybeSingle();
  if (!user?.is_admin) return res.status(403).json({ error: 'Accès refusé' });
  const { data } = await supabase.from('blacklist').select('*').order('created_at', { ascending: false });
  res.json(data || []);
});

app.post('/blacklist', async (req, res) => {
  const { discord_id, target_discord_id, target_username, reason } = req.body;
  const { data: user } = await supabase.from('discord_users').select('is_admin, username').eq('discord_id', discord_id).maybeSingle();
  if (!user?.is_admin) return res.status(403).json({ error: 'Accès refusé' });
  const { error } = await supabase.from('blacklist').upsert({
    discord_id: target_discord_id, username: target_username,
    reason: reason || '', added_by: user.username, created_at: new Date().toISOString()
  }, { onConflict: 'discord_id' });
  if (error) return res.status(500).json({ error: 'Erreur BDD' });
  res.json({ success: true });
});

app.delete('/blacklist/:target_id', async (req, res) => {
  const { discord_id } = req.body;
  const { data: user } = await supabase.from('discord_users').select('is_admin').eq('discord_id', discord_id).maybeSingle();
  if (!user?.is_admin) return res.status(403).json({ error: 'Accès refusé' });
  await supabase.from('blacklist').delete().eq('discord_id', req.params.target_id);
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`BCSO Backend port ${PORT} ✅`));
