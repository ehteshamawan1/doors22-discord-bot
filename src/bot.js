require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');

// Initialize Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Bot ready event
client.on('ready', () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);
  console.log(`Server ID: ${process.env.DISCORD_GUILD_ID}`);
  console.log(`Channel ID: ${process.env.DISCORD_CHANNEL_ID}`);
});

// Message handler for Midjourney responses
client.on('messageCreate', async (message) => {
  try {
    // Check if message is from Midjourney bot
    if (message.author.id !== process.env.MIDJOURNEY_BOT_ID) return;

    // Check if message is in the configured channel
    if (message.channel.id !== process.env.DISCORD_CHANNEL_ID) return;

    console.log('📩 Received message from Midjourney:', message.id);

    // Check if message has image attachments
    if (message.attachments.size > 0) {
      message.attachments.forEach(attachment => {
        console.log('🖼️  Image URL:', attachment.url);
        // TODO: Download and process image
      });
    }
  } catch (error) {
    console.error('Error handling message:', error);
  }
});

// Error handler
client.on('error', (error) => {
  console.error('Discord client error:', error);
});

// Login to Discord
client.login(process.env.DISCORD_BOT_TOKEN)
  .then(() => console.log('🚀 Discord bot starting...'))
  .catch(err => {
    console.error('❌ Failed to login:', err);
    process.exit(1);
  });

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  client.destroy();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  client.destroy();
  process.exit(0);
});
