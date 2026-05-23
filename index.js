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
const DISCORD_ACCEPTED_ROLE  = '1503182444067557510'; // Rôle donné quand accepté
const DISCORD_NOTIF_ROLE     = '1503182444067557513'; // Rôle pingé pour nouvelles candidatures
const DISCORD_REFUSE_1       = '1504421729345343559';
const DISCORD_REFUSE_2       = '1504421833112424510';
const DISCORD_REFUSE_PERM    = '1504421845716303993';

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const SUPABASE_URL        = 'https://qvtlllgqrxkefwrbmmpj.supabase.co';
const SUPABASE_KEY        = process.env.SUPABASE_KEY || '';
const FRONTEND_URL        = 'https://sheriff-academy.netlify.app';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── BOT DISCORD — Donner/Retirer un rôle ──────────────────
async function addRoleToMember(guildId, userId, roleId) {
  try {
    await axios.put(
      `https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${roleId}`,
      {},
      { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json', 'X-Audit-Log-Reason': 'Candidature acceptée par le BCSO' } }
    );
    console.log(`✅ Rôle ${roleId} attribué à ${userId}`);
    return true;
  } catch (err) {
    console.error('❌ Erreur attribution rôle:', err.response?.data || err.message);
    return false;
  }
}

async function removeRoleFromMember(guildId, userId, roleId) {
  try {
    await axios.delete(
      `https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${roleId}`,
      { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, 'X-Audit-Log-Reason': 'Candidature refusée/annulée BCSO' } }
    );
    console.log(`✅ Rôle ${roleId} retiré de ${userId}`);
    return true;
  } catch (err) {
    console.error('❌ Erreur retrait rôle:', err.response?.data || err.message);
    return false;
  }
}

// ── BOT DISCORD — Récupérer les rôles d'un membre ─────────
async function getMemberRoles(guildId, userId) {
  try {
    const res = await axios.get(
      `https://discord.com/api/v10/guilds/${guildId}/members/${userId}`,
      { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` } }
    );
    return res.data.roles || [];
  } catch (err) {
    console.error('Erreur getMemberRoles:', err.response?.data || err.message);
    return null; // null = membre pas trouvé ou erreur
  }
}

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

    // Récupérer les guilds via OAuth
    let userGuilds = [];
    try {
      const guildsRes = await axios.get('https://discord.com/api/users/@me/guilds', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      userGuilds = guildsRes.data.map(g => g.id);
    } catch {}

    // Vérifier rôles admin BCSO (via OAuth)
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

    // ── VÉRIFICATION RÔLES CANDIDATURE VIA BOT (plus fiable que OAuth) ──
    let candStatus = 'not_in_server';
    let candRefuseCount = 0;

    // D'abord vérifier si dans le serveur via les guilds OAuth
    const inCandServer = userGuilds.includes(DISCORD_CAND_GUILD_ID);

    if (inCandServer) {
      // Utiliser le BOT pour récupérer les rôles (toujours à jour, pas de cache)
      const candRoles = await getMemberRoles(DISCORD_CAND_GUILD_ID, user.id);

      if (candRoles === null) {
        // Fallback OAuth si le bot échoue
        try {
          const candMemberRes = await axios.get(
            `https://discord.com/api/users/@me/guilds/${DISCORD_CAND_GUILD_ID}/member`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );
          const fallbackRoles = candMemberRes.data.roles || [];
          if (fallbackRoles.includes(DISCORD_REFUSE_PERM)) {
            candStatus = 'refused_perm'; candRefuseCount = 3;
          } else if (fallbackRoles.includes(DISCORD_REFUSE_2)) {
            candStatus = 'refused_2'; candRefuseCount = 2;
          } else if (fallbackRoles.includes(DISCORD_REFUSE_1)) {
            candStatus = 'refused_1'; candRefuseCount = 1;
          } else if (fallbackRoles.includes(DISCORD_CAND_ROLE)) {
            candStatus = 'ok';
          } else {
            candStatus = 'no_role';
          }
        } catch { candStatus = 'no_role'; }
      } else {
        // Bot OK — rôles en temps réel
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

// ── REFRESH ROLES — endpoint appelé sans reconnexion complète ──
app.get('/auth/refresh/:discord_id', async (req, res) => {
  const { discord_id } = req.params;
  try {
    // Vérifier BL
    const { data: bl } = await supabase.from('blacklist').select('reason').eq('discord_id', discord_id).maybeSingle();
    if (bl) return res.json({ error: 'blacklisted', reason: bl.reason });

    // Utiliser le bot pour récupérer les rôles en temps réel
    const candRoles = await getMemberRoles(DISCORD_CAND_GUILD_ID, discord_id);

    if (candRoles === null) {
      return res.json({ error: 'not_in_server' });
    }

    let candStatus = 'no_role';
    let candRefuseCount = 0;

    if (candRoles.includes(DISCORD_REFUSE_PERM)) {
      candStatus = 'refused_perm'; candRefuseCount = 3;
    } else if (candRoles.includes(DISCORD_REFUSE_2)) {
      candStatus = 'refused_2'; candRefuseCount = 2;
    } else if (candRoles.includes(DISCORD_REFUSE_1)) {
      candStatus = 'refused_1'; candRefuseCount = 1;
    } else if (candRoles.includes(DISCORD_CAND_ROLE)) {
      candStatus = 'ok';
    }

    // Vérifier si admin — via bot sur serveur admin, fallback BDD
    let isAdmin = false;
    let roleName = '';
    const adminRoles = await getMemberRoles(DISCORD_GUILD_ID, discord_id);
    if (adminRoles) {
      for (const [roleId, name] of Object.entries(DISCORD_ADMIN_ROLES)) {
        if (adminRoles.includes(roleId)) { isAdmin = true; roleName = name; break; }
      }
    }
    // Fallback : lire is_admin depuis la BDD si le bot ne peut pas vérifier
    if (!isAdmin) {
      const { data: dbUser } = await supabase.from('discord_users').select('is_admin, role_name').eq('discord_id', discord_id).maybeSingle();
      if (dbUser?.is_admin) { isAdmin = true; roleName = dbUser.role_name || ''; }
    }
    if (isAdmin) candStatus = 'ok';

    // Mettre à jour en BDD
    await supabase.from('discord_users').upsert({
      discord_id,
      is_admin: isAdmin,
      role_name: roleName,
      cand_status: candStatus,
      cand_refuse_count: candRefuseCount
    }, { onConflict: 'discord_id' });

    res.json({ candStatus, candRefuseCount, isAdmin, roleName });
  } catch (err) {
    console.error('Refresh error:', err.message);
    res.status(500).json({ error: 'refresh_failed' });
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

  if (error) { console.error('INSERT ERROR:', error); return res.status(500).json({ error: 'Erreur base de données: ' + error.message }); }

  // Webhook Discord — ping le rôle notif
  if (DISCORD_WEBHOOK_URL) {
    try {
      const qcmPct = qcm_total > 0 ? Math.round((qcm_score / qcm_total) * 100) : 0;
      const qcmEmoji = qcmPct >= 80 ? '🟢' : qcmPct >= 60 ? '🟡' : '🔴';
      await axios.post(DISCORD_WEBHOOK_URL, {
        content: `<@&${DISCORD_NOTIF_ROLE}> — Nouvelle candidature reçue sur le site !`,
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
            { name: '⚖️ Antécédents', value: antecedent ? `Oui${antecedent_details ? ' — ' + antecedent_details : ''}` : 'Non', inline: true },
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

// ── METTRE À JOUR STATUT (avec attribution de rôle Discord) ──
app.patch('/candidature/:id', async (req, res) => {
  const { discord_id, status } = req.body;
  if (!['pending', 'accepted', 'rejected'].includes(status)) return res.status(400).json({ error: 'Invalide' });
  const { data: user } = await supabase.from('discord_users').select('is_admin').eq('discord_id', discord_id).maybeSingle();
  if (!user?.is_admin) return res.status(403).json({ error: 'Accès refusé' });

  // Récupérer la candidature pour avoir le discord_id du candidat
  const { data: cand } = await supabase.from('candidatures').select('discord_id, prenom, nom, username').eq('id', req.params.id).single();

  await supabase.from('candidatures').update({ status, updated_at: new Date().toISOString() }).eq('id', req.params.id);

  // Attribution/retrait du rôle Discord via le bot
  if (cand?.discord_id && DISCORD_BOT_TOKEN) {
    if (status === 'accepted') {
      // Donner le rôle "Accepté"
      const ok = await addRoleToMember(DISCORD_CAND_GUILD_ID, cand.discord_id, DISCORD_ACCEPTED_ROLE);
      if (ok) {
        // Notifier sur Discord
        if (DISCORD_WEBHOOK_URL) {
          try {
            await axios.post(DISCORD_WEBHOOK_URL, {
              embeds: [{
                title: '✅ Candidature Acceptée',
                color: 0x2ECC71,
                description: `La candidature de **${cand.prenom} ${cand.nom}** (\`${cand.username}\`) a été **acceptée** ! Le rôle a été attribué automatiquement.`,
                timestamp: new Date().toISOString()
              }]
            });
          } catch {}
        }
      }
    } else if (status === 'rejected') {
      // Retirer le rôle Accepté si présent
      await removeRoleFromMember(DISCORD_CAND_GUILD_ID, cand.discord_id, DISCORD_ACCEPTED_ROLE);

      // Compter le nombre de refus pour ce candidat
      const { data: refusals } = await supabase
        .from('candidatures')
        .select('id')
        .eq('discord_id', cand.discord_id)
        .eq('status', 'rejected');
      const refusCount = (refusals || []).length; // inclut celui qu'on vient de refuser

      // Retirer les anciens rôles refus
      await removeRoleFromMember(DISCORD_CAND_GUILD_ID, cand.discord_id, DISCORD_REFUSE_1);
      await removeRoleFromMember(DISCORD_CAND_GUILD_ID, cand.discord_id, DISCORD_REFUSE_2);
      await removeRoleFromMember(DISCORD_CAND_GUILD_ID, cand.discord_id, DISCORD_REFUSE_PERM);

      // Donner le bon rôle selon le nombre de refus
      if (refusCount >= 3) {
        await addRoleToMember(DISCORD_CAND_GUILD_ID, cand.discord_id, DISCORD_REFUSE_PERM);
      } else if (refusCount === 2) {
        await addRoleToMember(DISCORD_CAND_GUILD_ID, cand.discord_id, DISCORD_REFUSE_2);
      } else {
        await addRoleToMember(DISCORD_CAND_GUILD_ID, cand.discord_id, DISCORD_REFUSE_1);
      }

      // Notif webhook
      if (DISCORD_WEBHOOK_URL) {
        try {
          await axios.post(DISCORD_WEBHOOK_URL, {
            embeds: [{
              title: '❌ Candidature Refusée',
              color: 0xB03030,
              description: `La candidature de **${cand.prenom} ${cand.nom}** (\`${cand.username}\`) a été **refusée**. Refus n°${refusCount}.`,
              timestamp: new Date().toISOString()
            }]
          });
        } catch {}
      }
    } else if (status === 'pending') {
      // Retirer le rôle Accepté si jamais il l'avait
      await removeRoleFromMember(DISCORD_CAND_GUILD_ID, cand.discord_id, DISCORD_ACCEPTED_ROLE);
    }
  }

  res.json({ success: true });
});

// ── SUPPRIMER CANDIDATURE ─────────────────────────────────
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
