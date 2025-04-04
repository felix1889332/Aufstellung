require('dotenv').config();
const fs = require('fs');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const cron = require('node-cron');
const express = require('express');
const moment = require('moment-timezone');
const { request } = require('undici');

// === Webserver für UptimeRobot & Self-Ping ===
const app = express();
const port = 3000;
app.get('/', (_, res) => res.send('🟢 Bot is alive!'));
app.listen(port, () => console.log(`🌐 Keep-Alive Server läuft auf Port ${port}`));
setInterval(() => {
  request('http://localhost:3000').catch(err => console.error('❌ Self-Ping fehlgeschlagen:', err));
}, 5 * 60 * 1000);

// === Nachrichtenverlauf laden
let lastMessages = {};
try {
  lastMessages = JSON.parse(fs.readFileSync('lastMessages.json', 'utf8'));
} catch { console.log("ℹ️ lastMessages.json wird neu erstellt"); }

// === Discord Client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// === Slash Commands
const commands = [
  new SlashCommandBuilder().setName('aufstellung').setDescription('Postet sofort eine Aufstellung'),
  new SlashCommandBuilder().setName('manual_aufstellung').setDescription('Postet manuell'),
  new SlashCommandBuilder().setName('ping').setDescription('Antwortet mit Pong!'),
  new SlashCommandBuilder().setName('info').setDescription('Infos zum Bot')
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

// === Bot Ready
client.once('ready', async () => {
  console.log(`✅ Eingeloggt als ${client.user.tag}`);
  client.user.setPresence({ activities: [{ name: "RP-Aktivität", type: 3 }], status: 'online' });

  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log("✅ Slash Commands registriert");
  } catch (err) {
    console.error("❌ Fehler beim Registrieren:", err);
    notifyError(`SlashCommand Fehler: ${err.message}`);
  }

  const startupChannel = await fetchChannel(process.env.STARTUP_CHANNEL_ID);
  if (startupChannel) startupChannel.send("🟢 **Bot wurde gestartet**");
});

// === Aufstellung posten
async function postAufstellung() {
  const morgen = moment().tz("Europe/Berlin").add(1, 'days').format('DD.MM.');
  const text = `**Aufstellung am ${morgen} um 20 Uhr**\n\nReagiere bis **19 Uhr**. Wer nicht reagiert = Sanki <@BBG>`;

  const ids = process.env.CHANNEL_IDS.split(',');
  for (const id of ids) {
    const channel = await fetchChannel(id.trim());
    if (!channel) continue;

    try {
      const msg = await channel.send(text);
      await msg.react('✅');
      await msg.react('❌');

      lastMessages[id.trim()] = msg.id;
      fs.writeFileSync('lastMessages.json', JSON.stringify(lastMessages, null, 2));
      console.log(`📢 Aufstellung in ${id} gesendet`);
    } catch (e) {
      console.error(`❌ Fehler in ${id}:`, e);
      notifyError(`Fehler beim Senden in ${id}: ${e.message}`);
    }
  }
}

// === Auswertung
async function auswerten() {
  const logChannel = await fetchChannel(process.env.LOG_CHANNEL_ID);
  if (!logChannel) return;

  const ids = process.env.CHANNEL_IDS.split(',');
  for (const id of ids) {
    const channel = await fetchChannel(id.trim());
    if (!channel) continue;

    const msgId = lastMessages[id.trim()];
    if (!msgId) continue;

    try {
      const message = await channel.messages.fetch(msgId);
      const yes = message.reactions.cache.get('✅');
      const no = message.reactions.cache.get('❌');

      const zusagen = yes ? [...(await yes.users.fetch()).values()].filter(u => !u.bot).map(u => u.username) : [];
      const absagen = no ? [...(await no.users.fetch()).values()].filter(u => !u.bot).map(u => u.username) : [];

      const heute = moment().tz("Europe/Berlin").format('DD.MM.');
      const summary = `📋 **Aufstellung ${heute}** (<#${id}>):\n✅ ${zusagen.join(', ') || 'Keine'}\n❌ ${absagen.join(', ') || 'Keine'}`;

      await logChannel.send(summary);
    } catch (e) {
      console.error(`❌ Fehler bei Auswertung in ${id}:`, e);
      notifyError(`Fehler bei Auswertung in ${id}: ${e.message}`);
    }
  }
}

// === Cronjobs
cron.schedule('0 20 * * *', () => {
  console.log("🕗 Cron 20:00 – Aufstellung");
  postAufstellung();
}, { timezone: "Europe/Berlin" });

cron.schedule('0 19 * * *', () => {
  console.log("🕖 Cron 19:00 – Auswertung");
  auswerten();
}, { timezone: "Europe/Berlin" });

// === SlashCommand Handling
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  try {
    const { commandName } = interaction;

    if (commandName === 'aufstellung' || commandName === 'manual_aufstellung') {
      await postAufstellung();
      return interaction.reply({ content: "📨 Aufstellung gesendet", ephemeral: true });
    }

    if (commandName === 'ping') {
      return interaction.reply("🏓 Pong!");
    }

    if (commandName === 'info') {
      return interaction.reply("🤖 Ich poste täglich um 20 Uhr die Aufstellung und werte um 19 Uhr aus.");
    }
  } catch (e) {
    console.error("❌ Fehler im SlashCommand:", e);
    notifyError(`SlashCommand Fehler: ${e.message}`);
    if (interaction.replied || interaction.deferred) return;
    await interaction.reply({ content: "❌ Fehler beim Ausführen.", ephemeral: true });
  }
});

// === Fehler-Handling & Benachrichtigung
process.on("unhandledRejection", (err) => {
  console.error("❌ Unhandled Promise:", err);
  notifyError(`Unhandled Rejection:\n${err.message}`);
});
process.on("uncaughtException", (err) => {
  console.error("💥 Uncaught Exception:", err);
  notifyError(`Uncaught Exception:\n${err.message}`);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// === Helper
async function fetchChannel(id) {
  try {
    const ch = await client.channels.fetch(id);
    return ch && ch.viewable ? ch : null;
  } catch {
    console.error(`❌ Channel ${id} nicht erreichbar`);
    return null;
  }
}

async function notifyError(msg) {
  const ch = await fetchChannel(process.env.ALERT_CHANNEL_ID);
  if (ch) ch.send(`🚨 Fehler:\n\`\`\`${msg}\`\`\``).catch(console.error);
}

async function shutdown() {
  const ch = await fetchChannel(process.env.STARTUP_CHANNEL_ID);
  if (ch) await ch.send("🔴 Bot wird beendet...");
  process.exit(0);
}

client.login(process.env.TOKEN);


