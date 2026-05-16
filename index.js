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

// ── CONFIG ──────────────────────────────────────────────
const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID     || '1504256148768030800';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const DISCORD_REDIRECT_URI  = 'https://bcso-backend-production.up.railway.app/auth/callback';
const DISCORD_BOT_TOKEN     = process.env.DISCORD_BOT_TOKEN     || '';

// Serveur BCSO admin
const DISCORD_GUILD_ID    = '1464245148035842060';
const DISCORD_ADMIN_ROLES = {
  '1504268880447803403': 'Sheriff Office',
  '1464245148396421182': 'Human Resources'
};

// Serveur candidature
const DISCORD_CAND_GUILD_ID  = '1503182444067557508';
const DISCORD_CAND_ROLE      = '1503182444067557509'; // Citoyen
const DISCORD_ACCEPTED_ROLE  = '1503182444067557510'; // Rôle donné à l'acceptation
const DISCORD_PING_ROLE      = '1503182444067557513'; // Rôle pingé dans le webhook
const DISCORD_REFUSE_1       = '1504421729345343559';
const DISCORD_REFUSE_2       = '1504421833112424510';
const DISCORD_REFUSE_PERM    = '1504421845716303993';

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const SUPABASE_URL        = 'https://qvtlllgqrxkefwrbmmpj.supabase.co';
const SUPABASE_KEY        = process.env.SUPABASE_KEY || '';
const FRONTEND_URL        = 'https://sheriff-academy.netlify.app';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── HELPER : Donner un rôle via le bot ───────────────────
async function giveRole(discord_id, role_id) {
  if (!DISCORD_BOT_TOKEN) { console.error('Bot token manquant'); return false; }
  try {
    await axios.put(
      `https://discord.com/api/v10/guilds/${DISCORD_CAND_GUILD_ID}/members/${discord_id}/roles/${role_id}`,
      {},
      { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    console.log(`✅ Rôle ${role_id} donné à ${discord_id}`);
    return true;
  } catch (err) {
    console.error(`❌ Erreur attribution rôle: ${err.response?.status} — ${JSON.stringify(err.response?.data)}`);
    return false;
  }
}

// ── HELPER : Retirer un rôle via le bot ─────────────────
async function removeRole(discord_id, role_id) {
  if (!DISCORD_BOT_TOKEN) return false;
  try {
    await axios.delete(
      `https://discord.com/api/v10/guilds/${DISCORD_CAND_GUILD_ID}/members/${discord_id}/roles/${role_id}`,
      { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` } }
    );
    return true;
  } catch (err) {
    console.error(`❌ Erreur retrait rôle: ${err.response?.status}`);
    return false;
  }
}

// ── SANITY CHECK ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'BCSO Backend opérationnel ✅', bot: !!DISCORD_BOT_TOKEN });
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
      return res.redirect(`${FRONTEND_URL}?error=blacklisted&reason=${encodeURIComponent(blEntry.reason || 'Aucune raison')}`);
    }

    // Guilds de l'utilisateur
    let userGuilds = [];
    try {
      const guildsRes = await axios.get('https://discord.com/api/users/@me/guilds', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      userGuilds = guildsRes.data.map(g => g.id);
    } catch {}

    // Vérifier rôles admin
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

    // Vérifier serveur candidature — via le BOT pour avoir les rôles à jour
    let candStatus = 'not_in_server';
    let candRefuseCount = 0;
    const inCandServer = userGuilds.includes(DISCORD_CAND_GUILD_ID);

    if (inCandServer) {
      // Utiliser le bot pour lire les rôles à jour (plus fiable que le token user)
      let candRoles = [];
      try {
        const botMemberRes = await axios.get(
          `https://discord.com/api/v10/guilds/${DISCORD_CAND_GUILD_ID}/members/${user.id}`,
          { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` } }
        );
        candRoles = botMemberRes.data.roles || [];
      } catch {
        // Fallback : token user
        try {
          const candMemberRes = await axios.get(
            `https://discord.com/api/users/@me/guilds/${DISCORD_CAND_GUILD_ID}/member`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );
          candRoles = candMemberRes.data.roles || [];
        } catch {}
      }

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
    }

    // Admins bypass
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

// ── REFRESH STATUS (pour actualisation sans déconnexion) ──
app.get('/auth/refresh/:discord_id', async (req, res) => {
  const { discord_id } = req.params;
  if (!DISCORD_BOT_TOKEN) return res.json({ error: 'Bot token manquant' });

  try {
    // Vérifier si le membre est dans le serveur
    let candStatus = 'not_in_server';
    let candRefuseCount = 0;

    try {
      const botRes = await axios.get(
        `https://discord.com/api/v10/guilds/${DISCORD_CAND_GUILD_ID}/members/${discord_id}`,
        { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` } }
      );
      const roles = botRes.data.roles || [];

      if (roles.includes(DISCORD_REFUSE_PERM)) {
        candStatus = 'refused_perm'; candRefuseCount = 3;
      } else if (roles.includes(DISCORD_REFUSE_2)) {
        candStatus = 'refused_2'; candRefuseCount = 2;
      } else if (roles.includes(DISCORD_REFUSE_1)) {
        candStatus = 'refused_1'; candRefuseCount = 1;
      } else if (roles.includes(DISCORD_CAND_ROLE)) {
        candStatus = 'ok';
      } else {
        candStatus = 'no_role';
      }
    } catch (e) {
      if (e.response?.status === 404) candStatus = 'not_in_server';
    }

    // Vérifier si admin
    const { data: userDb } = await supabase.from('discord_users').select('is_admin, role_name').eq('discord_id', discord_id).maybeSingle();
    if (userDb?.is_admin) candStatus = 'ok';

    // Mettre à jour en BDD
    await supabase.from('discord_users').update({
      cand_status: candStatus,
      cand_refuse_count: candRefuseCount
    }).eq('discord_id', discord_id);

    res.json({ cand_status: candStatus, cand_refuse_count: candRefuseCount });
  } catch (err) {
    console.error('Refresh error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
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

  if (error) { console.error('BDD Error:', error); return res.status(500).json({ error: 'Erreur base de données: ' + error.message }); }

  // Webhook Discord — ping le rôle
  if (DISCORD_WEBHOOK_URL) {
    try {
      const qcmPct = qcm_total > 0 ? Math.round((qcm_score / qcm_total) * 100) : 0;
      const qcmEmoji = qcmPct >= 80 ? '🟢' : qcmPct >= 60 ? '🟡' : '🔴';
      await axios.post(DISCORD_WEBHOOK_URL, {
        content: `<@&${DISCORD_PING_ROLE}> 📋 Nouvelle candidature reçue sur le site !`,
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
            { name: '⚖️ Antécédents', value: antecedent ? `Oui${antecedent_details ? ' — ' + antecedent_details.substring(0, 100) : ''}` : 'Non', inline: true },
            { name: `${qcmEmoji} QCM Règlement`, value: `**${qcm_score}/${qcm_total}** (${qcmPct}%)`, inline: true },
            { name: '📝 Motivation', value: (motivation || '').substring(0, 400) + ((motivation || '').length > 400 ? '...' : '') }
          ],
          footer: { text: '🌐 Panel admin → sheriff-academy.netlify.app' },
          timestamp: new Date().toISOString()
        }]
      });
    } catch (e) { console.error('Webhook error:', e.message); }
  }

  res.json({ success: true, id: data.id });
});

// ── RÉCUPÉRER CANDIDATURES (admin) ───────────────────────
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

// ── STATUT (+ attribution rôle Discord si accepté) ────────
app.patch('/candidature/:id', async (req, res) => {
  const { discord_id, status } = req.body;
  if (!['pending', 'accepted', 'rejected'].includes(status)) return res.status(400).json({ error: 'Invalide' });
  const { data: user } = await supabase.from('discord_users').select('is_admin').eq('discord_id', discord_id).maybeSingle();
  if (!user?.is_admin) return res.status(403).json({ error: 'Accès refusé' });

  // Récupérer la candidature pour avoir le discord_id du candidat
  const { data: cand } = await supabase.from('candidatures').select('discord_id, prenom, nom').eq('id', req.params.id).single();

  await supabase.from('candidatures').update({ status, updated_at: new Date().toISOString() }).eq('id', req.params.id);

  // Si accepté → donner le rôle sur Discord
  if (status === 'accepted' && cand?.discord_id) {
    const roleGiven = await giveRole(cand.discord_id, DISCORD_ACCEPTED_ROLE);
    console.log(`Rôle accepté ${roleGiven ? 'donné' : 'ERREUR'} à ${cand.discord_id}`);
    return res.json({ success: true, role_given: roleGiven });
  }

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
