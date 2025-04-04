require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const cron = require('node-cron');
const express = require('express');
const moment = require('moment-timezone');
const { request } = require('undici');

const app = express();
const port = 3000;
const lastAufstellungMessages = {}; // channelId => messageId

// === Express Webserver für UptimeRobot & Self-Ping ===
app.get('/', (req, res) => res.send('🟢 Bot is alive!'));
app.listen(port, () => console.log(`🌐 Keep-Alive Server läuft auf Port ${port}`));

// === Self-Ping ===
setInterval(() => {
  request('http://localhost:3000').catch(err => console.error('❌ Self-Ping fehlgeschlagen:', err));
}, 5 * 60 * 1000);

// === Discord Client Initialisierung ===
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent
  ]
});

// === Slash Commands ===
const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Antwortet mit Pong!'),
  new SlashCommandBuilder().setName('info').setDescription('Infos zum Bot'),
  new SlashCommandBuilder().setName('manual_aufstellung').setDescription('Postet sofort eine Aufstellung')
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

client.once('ready', async () => {
  console.log(`✅ Eingeloggt als ${client.user.tag}`);
  try {
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    console.log('✅ Slash Commands registriert');
  } catch (err) {
    console.error('❌ Slash Commands Registrierung fehlgeschlagen:', err);
  }
});

// === Aufstellung posten ===
async function postAufstellungInAllChannels() {
  const morgen = moment().tz("Europe/Berlin").add(1, 'days').format('DD.MM.');
  const messageText = `**Aufstellung am ${morgen} um 20 Uhr**

Ihr habt Zeit bis **19 Uhr** zu reagieren.

Erscheint rechtzeitig am Cage, ausgerüstet mit dem erforderlichen Mindestbestand.

**Reagieren oder Sanki kassieren** <@&BBG>`;

  const channelIds = process.env.CHANNEL_IDS.split(',');

  for (const id of channelIds) {
    try {
      const channel = await client.channels.fetch(id.trim());
      const msg = await channel.send(messageText);
      await msg.react('✅');
      await msg.react('❌');
      lastAufstellungMessages[id.trim()] = msg.id;
      console.log(`📢 Aufstellung in Channel ${id} gesendet`);
    } catch (error) {
      console.error(`❌ Fehler beim Posten in Channel ${id}:`, error);
    }
  }
}

// === Täglicher Cronjob: Aufstellung um 20:00 Uhr ===
cron.schedule('0 20 * * *', () => {
  console.log('🕗 Starte täglichen Aufstellungspost');
  postAufstellungInAllChannels();
}, {
  timezone: "Europe/Berlin"
});

// === Täglicher Cronjob: Auswertung um 19:00 Uhr ===
cron.schedule('0 19 * * *', async () => {
  console.log('📊 Starte Auswertung der Reaktionen');

  try {
    const logChannel = await client.channels.fetch(process.env.LOG_CHANNEL_ID);
    if (!logChannel) {
      console.error('❌ Log-Channel nicht gefunden!');
      return;
    }

    const channelIds = process.env.CHANNEL_IDS.split(',');

    for (const id of channelIds) {
      try {
        const channel = await client.channels.fetch(id.trim());
        const messageId = lastAufstellungMessages[id.trim()];
        if (!messageId) {
          console.warn(`⚠️ Keine gespeicherte Nachricht für Channel ${id}`);
          continue;
        }

        const message = await channel.messages.fetch(messageId);
        const reactions = message.reactions.cache;

        const zusagen = [];
        const absagen = [];

        const yes = reactions.get('✅');
        const no = reactions.get('❌');

        if (yes) {
          const users = await yes.users.fetch();
          users.forEach(u => { if (!u.bot) zusagen.push(u.username); });
        }

        if (no) {
          const users = await no.users.fetch();
          users.forEach(u => { if (!u.bot) absagen.push(u.username); });
        }

        const heute = moment().tz("Europe/Berlin").format('DD.MM.');
        const summary = `📋 **Reaktionen zur Aufstellung am ${heute}** (Channel: <#${id.trim()}>)\n\n` +
          `✅ **Zugesagt:** ${zusagen.length > 0 ? zusagen.join(', ') : 'Keine'}\n` +
          `❌ **Abgesagt:** ${absagen.length > 0 ? absagen.join(', ') : 'Keine'}`;

        await logChannel.send(summary);
        console.log(`📩 Auswertung in Log-Channel gepostet (${id})`);
      } catch (err) {
        console.error(`❌ Fehler beim Auslesen in Channel ${id}:`, err);
      }
    }
  } catch (err) {
    console.error('❌ Fehler bei Auswertungsroutine:', err);
  }
}, {
  timezone: "Europe/Berlin"
});

// === Slash Command Handling ===
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === 'ping') {
      await interaction.reply('🏓 Pong!');
    }

    if (interaction.commandName === 'info') {
      await interaction.reply({
        content: 'Ich bin der tägliche Aufstellungs-Bot. Poste jeden Tag um 20 Uhr und werte um 19 Uhr aus.',
        ephemeral: true
      });
    }

    if (interaction.commandName === 'manual_aufstellung') {
      await postAufstellungInAllChannels();
      await interaction.reply({ content: '📢 Aufstellung wurde manuell gepostet.', ephemeral: true });
    }
  } catch (err) {
    console.error('❌ Fehler bei Command:', err);
    if (interaction.reply) {
      await interaction.reply({ content: '❌ Es gab einen Fehler beim Ausführen des Befehls.', ephemeral: true });
    }
  }
});

// === Globale Fehlerbehandlung ===
process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled Promise Rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
});

client.login(process.env.TOKEN);

