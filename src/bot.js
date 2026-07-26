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

function normalizeText(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[^\w\s#:-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getReferenceMessageId(message) {
  return message.reference?.messageId ||
    message.reference?.message_id ||
    message.reference?.message?.id ||
    message.reference?.message?.messageId ||
    null;
}

function getRequestFingerprint(request) {
  const prompt = request.imagePrompt || request.prompt || '';
  const withoutParams = String(prompt).replace(/\s--[\s\S]*$/, '');
  return normalizeText(withoutParams).slice(0, 220);
}

function rankRequestForMessage(request, message, normalizedContent) {
  let score = 0;
  const referenceMessageId = getReferenceMessageId(message);
  const fingerprint = getRequestFingerprint(request);
  const sentAt = request.sentAt ? new Date(request.sentAt).getTime() : 0;
  const ageMs = sentAt ? Date.now() - sentAt : Number.MAX_SAFE_INTEGER;

  if (request.messageId && (request.messageId === message.id || request.messageId === referenceMessageId)) {
    score += 120;
  }

  if (request.sourceMessageId && (request.sourceMessageId === message.id || request.sourceMessageId === referenceMessageId)) {
    score += 160;
  }

  if (request.selectedButton) {
    const selectedIndex = request.selectedButton.replace(/^U/i, '');
    if (selectedIndex && normalizedContent.includes(`image #${selectedIndex}`)) {
      score += 80;
    }
  }

  if (fingerprint && normalizedContent) {
    if (normalizedContent.includes(fingerprint)) {
      score += 100;
    } else {
      const sample = fingerprint.slice(0, 120);
      if (sample && normalizedContent.includes(sample)) {
        score += 60;
      }
    }
  }

  if (ageMs <= 2 * 60 * 1000) {
    score += 30;
  } else if (ageMs <= 10 * 60 * 1000) {
    score += 10;
  }

  return score;
}

function pickBestRequest(pendingRequests, predicate, message) {
  const normalizedContent = normalizeText(message.content || '');
  const candidates = pendingRequests
    .filter(([, request]) => predicate(request))
    .map(([requestId, request]) => ({
      requestId,
      request,
      score: rankRequestForMessage(request, message, normalizedContent)
    }))
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return new Date(b.request.sentAt || 0) - new Date(a.request.sentAt || 0);
    });

  if (candidates.length === 0) {
    return null;
  }

  if (candidates[0].score > 0 || candidates.length === 1) {
    return candidates[0];
  }

  const freshest = candidates[0];
  const freshestAgeMs = freshest.request.sentAt ? Date.now() - new Date(freshest.request.sentAt).getTime() : Number.MAX_SAFE_INTEGER;
  if (freshestAgeMs <= 10 * 60 * 1000) {
    return freshest;
  }

  return null;
}

async function handleMidjourneyMessage(message, eventType) {
  if (!message) {
    return;
  }

  if (message.partial) {
    try {
      await message.fetch();
    } catch (error) {
      console.error(`Failed to fetch partial Midjourney message during ${eventType}:`, error);
      return;
    }
  }

  if (message.author.id !== process.env.MIDJOURNEY_BOT_ID) return;
  if (message.channel.id !== process.env.DISCORD_CHANNEL_ID) return;

  console.log(`Received Midjourney ${eventType}: ${message.id}`);

  if (message.attachments.size === 0) {
    return;
  }

  const attachment = message.attachments.first();
  const mediaUrl = attachment.url;
  console.log('Media URL:', mediaUrl);

  const contentType = attachment.contentType || '';
  const fileName = attachment.name || '';
  const urlLower = mediaUrl.toLowerCase();
  const nameLower = fileName.toLowerCase();
  const extMatch = (nameLower.match(/\.(\w+)(?:\?|$)/) || urlLower.match(/\.(\w+)(?:\?|$)/));
  const ext = extMatch ? extMatch[1] : '';

  const isPng = ext === 'png' || urlLower.includes('.png');
  const isJpg = ext === 'jpg' || ext === 'jpeg' || urlLower.includes('.jpg') || urlLower.includes('.jpeg');
  const isWebp = ext === 'webp' || urlLower.includes('.webp');
  const isImageType = contentType.startsWith('image/') || isPng || isJpg || isWebp;
  const isVideo = contentType.startsWith('video/') || urlLower.includes('.mp4') || urlLower.includes('.mov') || urlLower.includes('/video/');

  console.log(`Media type: contentType=${contentType} name=${fileName} ext=${ext} isPng=${isPng} isJpg=${isJpg} isWebp=${isWebp} isVideo=${isVideo}`);

  const hasUpscaleButtons = message.components && message.components.length > 0 &&
    message.components[0].components.some(btn =>
      btn.label && ['U1', 'U2', 'U3', 'U4'].includes(btn.label));

  console.log(`Message has upscale buttons: ${hasUpscaleButtons}`);

  const pendingRequests = Array.from(apiServer.pendingRequests.entries());
  const mediaType = isVideo ? 'video' : isImageType ? 'image' : null;
  const normalizedContent = normalizeText(message.content || '');

  const matchAndHandle = async (predicate, handler) => {
    const bestMatch = pickBestRequest(pendingRequests, predicate, message);
    if (!bestMatch) {
      return false;
    }

    const { requestId, request } = bestMatch;
    request.messageId = message.id;
    apiServer.pendingRequests.set(requestId, request);
    await handler(requestId, request);
    return true;
  };

  if (mediaType) {
    const bestButtonRequest = pickBestRequest(
      pendingRequests,
      (request) => (
        (request.type === 'button_click' || request.type === 'animate') &&
        (!request.expectedType ||
          request.expectedType === mediaType ||
          (request.expectedType === 'video' && isWebp)) &&
        (
          request.type !== 'button_click' ||
          request.expectedType !== 'image' ||
          (
            isPng &&
            !hasUpscaleButtons &&
            (
              normalizedContent.includes('image #') ||
              normalizedContent.includes('upscaled by') ||
              getReferenceMessageId(message) === request.sourceMessageId
            )
          )
        )
      ),
      message
    );

    if (bestButtonRequest) {
      const { requestId, request } = bestButtonRequest;
      request.messageId = message.id;
      apiServer.pendingRequests.set(requestId, request);
      apiServer.completeRequest(requestId, mediaUrl, message.id);
      return;
    }
  }

  if (await matchAndHandle(
    (request) => request.type === 'video' && request.currentStep === 'video' && (isWebp || isVideo),
    async (requestId) => {
      console.log(`Matched video request ${requestId} with ${isWebp ? 'WebP' : 'video'} file`);
      if (hasUpscaleButtons) {
        console.log('Video needs upscaling before completion');
        await apiServer.handleVideoUpscale(requestId, mediaUrl, message);
      } else {
        apiServer.completeRequest(requestId, mediaUrl, message.id);
      }
    }
  )) {
    return;
  }

  if (await matchAndHandle(
    (request) => request.type === 'video' && request.currentStep === 'upscaling_video' && (isWebp || isVideo) && !hasUpscaleButtons,
    async (requestId) => {
      console.log(`Matched upscaled video for request ${requestId}`);
      apiServer.completeRequest(requestId, mediaUrl, message.id);
    }
  )) {
    return;
  }

  if (await matchAndHandle(
    (request) => request.type === 'image' && request.currentStep === 'upscaling' && isPng && !hasUpscaleButtons,
    async (requestId) => {
      console.log(`Matched upscaled image for request ${requestId}`);
      await apiServer.handleUpscaledImageComplete(requestId, mediaUrl);
    }
  )) {
    return;
  }

  if (await matchAndHandle(
    (request) => request.type === 'video' && request.currentStep === 'upscale_base_image' && isPng && !hasUpscaleButtons,
    async (requestId) => {
      console.log(`Matched upscaled base image for video request ${requestId}`);
      await apiServer.handleUpscaledImageComplete(requestId, mediaUrl);
    }
  )) {
    return;
  }

  if (await matchAndHandle(
    (request) => (isPng || (isWebp && hasUpscaleButtons)) && (request.type === 'image' || (request.type === 'video' && request.currentStep === 'image')),
    async (requestId, request) => {
      console.log(`Matched base image request ${requestId}`);
      request.sourceMessageId = message.id;
      apiServer.pendingRequests.set(requestId, request);

      if (hasUpscaleButtons) {
        console.log('Image has 4-grid, needs upscaling');
        if (request.manualUpscale) {
          apiServer.completeRequest(requestId, mediaUrl, message.id);
        } else {
          await apiServer.handleImageUpscale(requestId, mediaUrl, message);
        }
      } else {
        await apiServer.handleImageComplete(requestId, mediaUrl);
      }
    }
  )) {
    return;
  }

  console.log('No matching request found for this media');
}

// Bot ready event
client.on('ready', () => {
  console.log(`âœ… Bot logged in as ${client.user.tag}`);
  console.log(`Server ID: ${process.env.DISCORD_GUILD_ID}`);
  console.log(`Channel ID: ${process.env.DISCORD_CHANNEL_ID}`);

  // Start API server after bot is ready
  apiServer.start();
});

client.on('messageCreate', async (message) => {
  try {
    await handleMidjourneyMessage(message, 'messageCreate');
  } catch (error) {
    console.error('Error handling message:', error);
  }
});

client.on('messageUpdate', async (_oldMessage, newMessage) => {
  try {
    await handleMidjourneyMessage(newMessage, 'messageUpdate');
  } catch (error) {
    console.error('Error handling updated message:', error);
  }
});

client.on('raw', async (packet) => {
  if (!packet || !['MESSAGE_CREATE', 'MESSAGE_UPDATE'].includes(packet.t)) {
    return;
  }

  const data = packet.d || {};
  if (data.author?.id !== process.env.MIDJOURNEY_BOT_ID) {
    return;
  }

  if (data.channel_id !== process.env.DISCORD_CHANNEL_ID) {
    return;
  }

  try {
    const channel = await client.channels.fetch(data.channel_id);
    const message = await channel.messages.fetch(data.id);
    await handleMidjourneyMessage(message, `raw:${packet.t}`);
  } catch (error) {
    console.error(`Error handling raw ${packet.t} event for ${data.id}:`, error.message);
  }
});

// Error handler
client.on('error', (error) => {
  console.error('Discord client error:', error);
});

// Login to Discord
client.login(process.env.DISCORD_BOT_TOKEN)
  .then(() => console.log('ðŸš€ Discord bot starting...'))
  .catch(err => {
    console.error('âŒ Failed to login:', err);
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
