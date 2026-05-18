import discord
from discord.ext import commands, tasks
from datetime import datetime
import json
import os

TOKEN = os.environ["TOKEN"]
DATA_FILE = "pointages.json"
CONFIG_FILE = "config.json"

intents = discord.Intents.default()
intents.message_content = True
intents.members = True
bot = commands.Bot(command_prefix="!", intents=intents)

def load():
    if os.path.exists(DATA_FILE):
        with open(DATA_FILE, "r") as f:
            return json.load(f)
    return {}

def save(data):
    with open(DATA_FILE, "w") as f:
        json.dump(data, f, indent=2)

def load_config():
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, "r") as f:
            return json.load(f)
    return {}

def save_config(cfg):
    with open(CONFIG_FILE, "w") as f:
        json.dump(cfg, f)

def fmt(seconds):
    seconds = int(max(0, seconds))
    h = seconds // 3600
    m = (seconds % 3600) // 60
    s = seconds % 60
    return f"{h}h{m:02d}m{s:02d}s"

def get_elapsed(u):
    now = datetime.utcnow().timestamp()
    pauses = u.get("total_pauses", 0)
    if u["status"] == "paused":
        pauses += now - u["pause_start"]
    return max(0, now - u["start"] - pauses + u.get("bonus_seconds", 0))

def get_pause_duration(u):
    now = datetime.utcnow().timestamp()
    total = u.get("total_pauses", 0)
    if u["status"] == "paused":
        total += now - u["pause_start"]
    return total

# ─── Embeds ───────────────────────────────────────────────────
async def build_pointeuse_embed(guild, data):
    embed = discord.Embed(title="🕐 POINTEUSE", color=0x1abc9c)
    en_service = [(uid, u) for uid, u in data.items() if u["status"] == "working"]
    en_pause = [(uid, u) for uid, u in data.items() if u["status"] == "paused"]
    lines = []
    for uid, u in en_service:
        member = guild.get_member(int(uid))
        name = member.display_name if member else f"<@{uid}>"
        lines.append(f"🟢 **{name}** — `{fmt(get_elapsed(u))}`")
    for uid, u in en_pause:
        member = guild.get_member(int(uid))
        name = member.display_name if member else f"<@{uid}>"
        lines.append(f"⏸️ **{name}** — `{fmt(get_elapsed(u))}` *(pause: {fmt(get_pause_duration(u))})*")
    embed.description = "\n".join(lines) if lines else "*Personne en service actuellement*"
    embed.set_footer(text=f"Blaine County Sheriff Office • {datetime.utcnow().strftime('%H:%M:%S')} UTC")
    return embed

async def build_gestion_embed(guild, data):
    now = datetime.utcnow()
    cfg = load_config()
    embed = discord.Embed(title="📊 PANNEAU DE GESTION", color=0xe74c3c, timestamp=now)
    en_service = [(uid, u) for uid, u in data.items() if u["status"] == "working"]
    en_pause = [(uid, u) for uid, u in data.items() if u["status"] == "paused"]
    hors_service = [(uid, u) for uid, u in data.items() if u["status"] == "off" and u.get("sessions")]

    if en_service:
        lines = []
        for uid, u in en_service:
            member = guild.get_member(int(uid))
            name = member.display_name if member else f"ID:{uid}"
            elapsed = get_elapsed(u)
            total_all = sum(s["duree_secondes"] for s in u.get("sessions", [])) + elapsed
            lines.append(f"🟢 **{name}**\n┣ Depuis : `{fmt(elapsed)}`\n┗ Total : `{fmt(total_all)}`")
        embed.add_field(name="━━━ EN SERVICE ━━━", value="\n\n".join(lines), inline=False)
    else:
        embed.add_field(name="━━━ EN SERVICE ━━━", value="*Personne*", inline=False)

    if en_pause:
        lines = []
        for uid, u in en_pause:
            member = guild.get_member(int(uid))
            name = member.display_name if member else f"ID:{uid}"
            elapsed = get_elapsed(u)
            total_all = sum(s["duree_secondes"] for s in u.get("sessions", [])) + elapsed
            lines.append(f"⏸️ **{name}**\n┣ Pause : `{fmt(get_pause_duration(u))}`\n┣ Travaillé : `{fmt(elapsed)}`\n┗ Total : `{fmt(total_all)}`")
        embed.add_field(name="━━━ EN PAUSE ━━━", value="\n\n".join(lines), inline=False)
    else:
        embed.add_field(name="━━━ EN PAUSE ━━━", value="*Personne*", inline=False)

    if hors_service:
        lines = []
        for uid, u in list(hors_service)[-5:]:
            member = guild.get_member(int(uid))
            name = member.display_name if member else f"ID:{uid}"
            last = u["sessions"][-1]
            total_all = sum(s["duree_secondes"] for s in u.get("sessions", []))
            lines.append(f"⬛ **{name}**\n┣ Dernière : `{fmt(last['duree_secondes'])}` ({last['date']})\n┗ Total : `{fmt(total_all)}`")
        embed.add_field(name="━━━ HORS SERVICE ━━━", value="\n\n".join(lines), inline=False)

    if cfg.get("comptage_start"):
        debut = datetime.utcfromtimestamp(cfg["comptage_start"]).strftime("%d/%m/%y à %H:%M:%S")
        duree = fmt(now.timestamp() - cfg["comptage_start"])
        embed.add_field(name="━━━ COMPTAGE EN COURS ━━━", value=f"▶️ Démarré le `{debut}` UTC\nDurée : `{duree}`", inline=False)

    total_en_ligne = len(en_service) + len(en_pause)
    embed.set_footer(text=f"👮 {total_en_ligne} agent(s) en ligne • Auto-refresh 3s")
    return embed

# ─── Vue pointeuse dynamique selon statut ────────────────────
# Un seul message public — les boutons affichés dépendent du statut de QUI clique
class PointeuseView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)

    @discord.ui.button(label="▶ Prendre service", style=discord.ButtonStyle.success, custom_id="pt_prendre", row=0)
    async def prendre(self, interaction: discord.Interaction, button: discord.ui.Button):
        data = load()
        uid = str(interaction.user.id)
        now = datetime.utcnow().timestamp()
        if uid in data and data[uid]["status"] != "off":
            await interaction.response.send_message("⚠️ Tu es déjà en service !", ephemeral=True)
            return
        if uid not in data:
            data[uid] = {"status": "off", "start": None, "pause_start": None, "total_pauses": 0, "sessions": [], "bonus_seconds": 0}
        data[uid].update({"status": "working", "start": now, "pause_start": None, "total_pauses": 0, "bonus_seconds": 0})
        cfg = load_config()
        if cfg.get("comptage_start"):
            if "comptage_sessions" not in cfg:
                cfg["comptage_sessions"] = {}
            cfg["comptage_sessions"][uid] = {"start": now, "total": 0}
            save_config(cfg)
        save(data)
        await interaction.response.send_message(f"✅ Service démarré.", ephemeral=True)
        await refresh_all(interaction.guild)

    @discord.ui.button(label="⏸ Pause", style=discord.ButtonStyle.primary, custom_id="pt_pause", row=0)
    async def pause(self, interaction: discord.Interaction, button: discord.ui.Button):
        data = load()
        uid = str(interaction.user.id)
        now = datetime.utcnow().timestamp()
        if data.get(uid, {}).get("status") != "working":
            await interaction.response.send_message("⚠️ Tu n'es pas en service.", ephemeral=True)
            return
        data[uid]["status"] = "paused"
        data[uid]["pause_start"] = now
        save(data)
        await interaction.response.send_message("⏸️ Pause enregistrée.", ephemeral=True)
        await refresh_all(interaction.guild)

    @discord.ui.button(label="▶ Reprendre", style=discord.ButtonStyle.secondary, custom_id="pt_reprendre", row=0)
    async def reprendre(self, interaction: discord.Interaction, button: discord.ui.Button):
        data = load()
        uid = str(interaction.user.id)
        now = datetime.utcnow().timestamp()
        if data.get(uid, {}).get("status") != "paused":
            await interaction.response.send_message("⚠️ Tu n'es pas en pause.", ephemeral=True)
            return
        data[uid]["total_pauses"] += now - data[uid]["pause_start"]
        data[uid]["pause_start"] = None
        data[uid]["status"] = "working"
        save(data)
        await interaction.response.send_message("🟢 Service repris.", ephemeral=True)
        await refresh_all(interaction.guild)

    @discord.ui.button(label="⏹ Fin de service", style=discord.ButtonStyle.danger, custom_id="pt_fin", row=0)
    async def fin(self, interaction: discord.Interaction, button: discord.ui.Button):
        data = load()
        uid = str(interaction.user.id)
        now = datetime.utcnow().timestamp()
        if data.get(uid, {}).get("status") == "off":
            await interaction.response.send_message("⚠️ Tu n'es pas en service.", ephemeral=True)
            return
        u = data[uid]
        if u["status"] == "paused":
            u["total_pauses"] += now - u["pause_start"]
        total = get_elapsed(u)
        cfg = load_config()
        if cfg.get("comptage_start") and "comptage_sessions" in cfg:
            cs = cfg["comptage_sessions"]
            if uid in cs and cs[uid].get("start"):
                cs[uid]["total"] += now - cs[uid]["start"]
                cs[uid]["start"] = None
            save_config(cfg)
        u["sessions"].append({"date": datetime.utcnow().strftime("%Y-%m-%d"), "duree_secondes": int(total)})
        u.update({"status": "off", "start": None, "pause_start": None, "total_pauses": 0, "bonus_seconds": 0})
        save(data)
        await interaction.response.send_message(f"✅ Fin de service — Temps: **{fmt(total)}**", ephemeral=True)
        await refresh_all(interaction.guild)

# ─── Refresh ──────────────────────────────────────────────────
async def refresh_pointeuse(guild, data):
    cfg = load_config()
    if cfg.get("pointeuse_channel_id") and cfg.get("pointeuse_msg_id"):
        ch = guild.get_channel(cfg["pointeuse_channel_id"])
        if ch:
            try:
                msg = await ch.fetch_message(cfg["pointeuse_msg_id"])
                await msg.edit(embed=await build_pointeuse_embed(guild, data))
            except:
                pass

async def refresh_gestion(guild, data):
    cfg = load_config()
    if cfg.get("gestion_channel_id") and cfg.get("gestion_msg_id"):
        ch = guild.get_channel(cfg["gestion_channel_id"])
        if ch:
            try:
                msg = await ch.fetch_message(cfg["gestion_msg_id"])
                await msg.edit(embed=await build_gestion_embed(guild, data), view=GestionView())
            except:
                pass

async def refresh_all(guild):
    data = load()
    await refresh_pointeuse(guild, data)
    await refresh_gestion(guild, data)

# ─── Vue Gestion admin ────────────────────────────────────────
class GestionView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)

    @discord.ui.button(label="⏹ Couper service", style=discord.ButtonStyle.danger, custom_id="admin_couper", row=0)
    async def couper(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not interaction.user.guild_permissions.administrator:
            await interaction.response.send_message("❌ Admins seulement.", ephemeral=True)
            return
        data = load()
        options = self._get_options(interaction.guild, data, ["working", "paused"])
        if not options:
            await interaction.response.send_message("Personne en service.", ephemeral=True)
            return
        await interaction.response.send_message("Sélectionne le membre :", view=SelectMembreView(options, "fin"), ephemeral=True)

    @discord.ui.button(label="⏸ Mettre en pause", style=discord.ButtonStyle.primary, custom_id="admin_pause", row=0)
    async def mettre_pause(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not interaction.user.guild_permissions.administrator:
            await interaction.response.send_message("❌ Admins seulement.", ephemeral=True)
            return
        data = load()
        options = self._get_options(interaction.guild, data, ["working"])
        if not options:
            await interaction.response.send_message("Personne en service actif.", ephemeral=True)
            return
        await interaction.response.send_message("Sélectionne le membre :", view=SelectMembreView(options, "pause"), ephemeral=True)

    @discord.ui.button(label="▶ Reprendre service", style=discord.ButtonStyle.secondary, custom_id="admin_reprendre", row=0)
    async def admin_reprendre(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not interaction.user.guild_permissions.administrator:
            await interaction.response.send_message("❌ Admins seulement.", ephemeral=True)
            return
        data = load()
        options = self._get_options(interaction.guild, data, ["paused"])
        if not options:
            await interaction.response.send_message("Personne en pause.", ephemeral=True)
            return
        await interaction.response.send_message("Sélectionne le membre :", view=SelectMembreView(options, "reprendre"), ephemeral=True)

    @discord.ui.button(label="➕ Ajouter temps", style=discord.ButtonStyle.success, custom_id="admin_add_time", row=1)
    async def add_time(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not interaction.user.guild_permissions.administrator:
            await interaction.response.send_message("❌ Admins seulement.", ephemeral=True)
            return
        data = load()
        options = self._get_options_all(interaction.guild, data)
        if not options:
            await interaction.response.send_message("Aucun membre enregistré.", ephemeral=True)
            return
        await interaction.response.send_message("Sélectionne le membre :", view=SelectMembreView(options, "add_time"), ephemeral=True)

    @discord.ui.button(label="➖ Retirer temps", style=discord.ButtonStyle.danger, custom_id="admin_remove_time", row=1)
    async def remove_time(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not interaction.user.guild_permissions.administrator:
            await interaction.response.send_message("❌ Admins seulement.", ephemeral=True)
            return
        data = load()
        options = self._get_options_all(interaction.guild, data)
        if not options:
            await interaction.response.send_message("Aucun membre enregistré.", ephemeral=True)
            return
        await interaction.response.send_message("Sélectionne le membre :", view=SelectMembreView(options, "remove_time"), ephemeral=True)

    @discord.ui.button(label="▶ Démarrer comptage", style=discord.ButtonStyle.success, custom_id="admin_comptage_start", row=2)
    async def comptage_start(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not interaction.user.guild_permissions.administrator:
            await interaction.response.send_message("❌ Admins seulement.", ephemeral=True)
            return
        cfg = load_config()
        if cfg.get("comptage_start"):
            await interaction.response.send_message("⚠️ Un comptage est déjà en cours.", ephemeral=True)
            return
        now = datetime.utcnow().timestamp()
        data = load()
        sessions = {}
        for uid, u in data.items():
            if u["status"] in ("working", "paused"):
                sessions[uid] = {"start": now, "total": 0}
        cfg["comptage_start"] = now
        cfg["comptage_sessions"] = sessions
        save_config(cfg)
        debut_fmt = datetime.utcnow().strftime("%d/%m/%y à %H:%M:%S")
        await interaction.response.send_message(f"▶️ Comptage démarré le `{debut_fmt}` UTC", ephemeral=True)
        await refresh_gestion(interaction.guild, data)

    @discord.ui.button(label="⏹ Terminer comptage", style=discord.ButtonStyle.danger, custom_id="admin_comptage_end", row=2)
    async def comptage_end(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not interaction.user.guild_permissions.administrator:
            await interaction.response.send_message("❌ Admins seulement.", ephemeral=True)
            return
        cfg = load_config()
        if not cfg.get("comptage_start"):
            await interaction.response.send_message("⚠️ Aucun comptage en cours.", ephemeral=True)
            return
        now = datetime.utcnow().timestamp()
        data = load()
        sessions = cfg.get("comptage_sessions", {})
        for uid, u in data.items():
            if u["status"] in ("working", "paused") and uid in sessions:
                if sessions[uid].get("start"):
                    sessions[uid]["total"] += now - sessions[uid]["start"]
        debut = datetime.utcfromtimestamp(cfg["comptage_start"]).strftime("%d/%m/%y à %H:%M")
        fin_str = datetime.utcnow().strftime("%d/%m/%y à %H:%M")
        duree_totale = fmt(now - cfg["comptage_start"])
        embed = discord.Embed(
            title="📋 RÉSUMÉ DU COMPTAGE",
            description=f"**Du** `{debut}` **au** `{fin_str}` UTC\n**Durée totale :** `{duree_totale}`",
            color=0xf39c12,
            timestamp=datetime.utcnow()
        )
        if sessions:
            lines = []
            for uid, s in sorted(sessions.items(), key=lambda x: x[1]["total"], reverse=True):
                member = interaction.guild.get_member(int(uid))
                name = member.display_name if member else f"ID:{uid}"
                lines.append(f"👮 **{name}** — `{fmt(s['total'])}`")
            embed.add_field(name="Temps de service par agent", value="\n".join(lines), inline=False)
        else:
            embed.description += "\n\n*Aucun agent enregistré.*"
        cfg.pop("comptage_start", None)
        cfg.pop("comptage_sessions", None)
        save_config(cfg)
        await interaction.response.send_message(embed=embed)
        await refresh_gestion(interaction.guild, data)

    def _get_options(self, guild, data, statuts):
        options = []
        for uid, u in data.items():
            if u["status"] in statuts:
                member = guild.get_member(int(uid))
                name = member.display_name if member else f"ID:{uid}"
                label = {"working": "🟢 En service", "paused": "⏸️ En pause"}.get(u["status"], "")
                options.append(discord.SelectOption(label=name, value=uid, description=label))
        return options

    def _get_options_all(self, guild, data):
        options = []
        for uid, u in data.items():
            member = guild.get_member(int(uid))
            name = member.display_name if member else f"ID:{uid}"
            label = {"working": "🟢 En service", "paused": "⏸️ En pause", "off": "⬛ Hors service"}.get(u["status"], "")
            options.append(discord.SelectOption(label=name, value=uid, description=label))
        return options[:25]

class SelectMembreView(discord.ui.View):
    def __init__(self, options, action):
        super().__init__(timeout=60)
        self.action = action
        select = discord.ui.Select(placeholder="Choisir un membre...", options=options)
        select.callback = self.on_select
        self.add_item(select)

    async def on_select(self, interaction: discord.Interaction):
        uid = interaction.data["values"][0]
        data = load()
        now = datetime.utcnow().timestamp()
        member = interaction.guild.get_member(int(uid))
        name = member.display_name if member else f"ID:{uid}"

        if self.action == "fin":
            u = data.get(uid)
            if not u or u["status"] == "off":
                await interaction.response.send_message(f"⚠️ **{name}** n'est pas en service.", ephemeral=True)
                return
            if u["status"] == "paused":
                u["total_pauses"] += now - u["pause_start"]
            total = get_elapsed(u)
            cfg = load_config()
            if cfg.get("comptage_start") and "comptage_sessions" in cfg:
                cs = cfg["comptage_sessions"]
                if uid in cs and cs[uid].get("start"):
                    cs[uid]["total"] += now - cs[uid]["start"]
                    cs[uid]["start"] = None
                save_config(cfg)
            u["sessions"].append({"date": datetime.utcnow().strftime("%Y-%m-%d"), "duree_secondes": int(total)})
            u.update({"status": "off", "start": None, "pause_start": None, "total_pauses": 0, "bonus_seconds": 0})
            save(data)
            await interaction.response.send_message(f"✅ Service de **{name}** coupé — `{fmt(total)}`.", ephemeral=True)
            await refresh_all(interaction.guild)

        elif self.action == "pause":
            data[uid]["status"] = "paused"
            data[uid]["pause_start"] = now
            save(data)
            await interaction.response.send_message(f"⏸️ **{name}** mis en pause.", ephemeral=True)
            await refresh_all(interaction.guild)

        elif self.action == "reprendre":
            data[uid]["total_pauses"] += now - data[uid]["pause_start"]
            data[uid]["pause_start"] = None
            data[uid]["status"] = "working"
            save(data)
            await interaction.response.send_message(f"🟢 **{name}** a repris le service.", ephemeral=True)
            await refresh_all(interaction.guild)

        elif self.action in ("add_time", "remove_time"):
            await interaction.response.send_modal(TempsModal(uid=uid, name=name, action=self.action))

class TempsModal(discord.ui.Modal):
    def __init__(self, uid, name, action):
        label = "Ajouter du temps" if action == "add_time" else "Retirer du temps"
        super().__init__(title=f"{label} — {name}")
        self.uid = uid
        self.action = action
        self.heures = discord.ui.TextInput(label="Heures", placeholder="0", required=False, max_length=3)
        self.minutes = discord.ui.TextInput(label="Minutes", placeholder="0", required=False, max_length=3)
        self.add_item(self.heures)
        self.add_item(self.minutes)

    async def on_submit(self, interaction: discord.Interaction):
        data = load()
        try:
            h = int(self.heures.value or 0)
            m = int(self.minutes.value or 0)
        except ValueError:
            await interaction.response.send_message("⚠️ Valeurs invalides.", ephemeral=True)
            return
        seconds = h * 3600 + m * 60
        uid = self.uid
        if uid not in data:
            data[uid] = {"status": "off", "start": None, "pause_start": None, "total_pauses": 0, "sessions": [], "bonus_seconds": 0}
        if "bonus_seconds" not in data[uid]:
            data[uid]["bonus_seconds"] = 0
        if data[uid]["status"] == "off":
            if not data[uid].get("sessions"):
                data[uid]["sessions"] = [{"date": datetime.utcnow().strftime("%Y-%m-%d"), "duree_secondes": 0}]
            if self.action == "add_time":
                data[uid]["sessions"][-1]["duree_secondes"] += seconds
            else:
                data[uid]["sessions"][-1]["duree_secondes"] = max(0, data[uid]["sessions"][-1]["duree_secondes"] - seconds)
        else:
            if self.action == "add_time":
                data[uid]["bonus_seconds"] += seconds
            else:
                data[uid]["bonus_seconds"] -= seconds
        save(data)
        msg = f"➕ `{h}h{m:02d}m` ajouté" if self.action == "add_time" else f"➖ `{h}h{m:02d}m` retiré"
        await interaction.response.send_message(msg, ephemeral=True)
        await refresh_all(interaction.guild)

# ─── Commandes ────────────────────────────────────────────────
@bot.command(name="pointeuse")
@commands.has_permissions(administrator=True)
async def pointeuse_cmd(ctx):
    data = load()
    embed = await build_pointeuse_embed(ctx.guild, data)
    msg = await ctx.send(embed=embed, view=PointeuseView())
    cfg = load_config()
    cfg["pointeuse_channel_id"] = ctx.channel.id
    cfg["pointeuse_msg_id"] = msg.id
    save_config(cfg)
    await ctx.message.delete()

@bot.command(name="gestion")
@commands.has_permissions(administrator=True)
async def gestion_cmd(ctx):
    data = load()
    embed = await build_gestion_embed(ctx.guild, data)
    msg = await ctx.send(embed=embed, view=GestionView())
    cfg = load_config()
    cfg["gestion_channel_id"] = ctx.channel.id
    cfg["gestion_msg_id"] = msg.id
    save_config(cfg)
    await ctx.message.delete()

@tasks.loop(seconds=3)
async def auto_refresh():
    for guild in bot.guilds:
        await refresh_all(guild)

@bot.event
async def on_ready():
    bot.add_view(PointeuseView())
    bot.add_view(GestionView())
    auto_refresh.start()
    print(f"✅ Bot connecté : {bot.user}")

bot.run(TOKEN)
