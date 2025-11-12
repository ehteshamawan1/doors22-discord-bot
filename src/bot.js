require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const APIServer = require('./server');

// Initialize Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Initialize API server
const apiServer = new APIServer(client);

// Bot ready event
client.on('ready', () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);
  console.log(`Server ID: ${process.env.DISCORD_GUILD_ID}`);
  console.log(`Channel ID: ${process.env.DISCORD_CHANNEL_ID}`);

  // Start API server after bot is ready
  apiServer.start();
});

// Message handler for Midjourney responses
client.on('messageCreate', async (message) => {
  try {
    // Check if message is from Midjourney bot
    if (message.author.id !== process.env.MIDJOURNEY_BOT_ID) return;

    // Check if message is in the configured channel
    if (message.channel.id !== process.env.DISCORD_CHANNEL_ID) return;

    console.log('📩 Received message from Midjourney:', message.id);

    // Check if message has attachments (generation completed)
    if (message.attachments.size > 0) {
      const attachment = message.attachments.first();
      const mediaUrl = attachment.url;
      console.log('🖼️  Media URL:', mediaUrl);

      // Determine if this is an image or video
      // URLs may have query parameters, so check if .png or .mp4 appears before query string
      const isVideo = mediaUrl.includes('.mp4') || mediaUrl.includes('.mov') || mediaUrl.includes('/video/');
      const isPng = mediaUrl.includes('.png');

      console.log(`Media type: ${isVideo ? 'video' : 'image'}, isPng: ${isPng}`);

      // Try to match with a pending request
      // Look through all pending requests to find a match
      let matchedRequestId = null;

      for (const [requestId, request] of apiServer.pendingRequests.entries()) {
        // For video requests on step 2, match videos
        if (request.type === 'video' && request.currentStep === 'video' && isVideo) {
          console.log(`✅ Matched video request ${requestId}`);
          matchedRequestId = requestId;
          apiServer.completeRequest(requestId, mediaUrl);
          break;
        }

        // For image requests or video step 1, match PNG images
        if (isPng) {
          // Check if this is an image request, or video request on step 1
          if (request.type === 'image' || (request.type === 'video' && request.currentStep === 'image')) {
            console.log(`✅ Matched image request ${requestId}`);
            matchedRequestId = requestId;
            await apiServer.handleImageComplete(requestId, mediaUrl);
            break;
          }
        }
      }

      if (!matchedRequestId) {
        console.log('⚠️  No matching request found for this media');
      }
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
