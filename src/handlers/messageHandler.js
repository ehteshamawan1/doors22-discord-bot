/**
 * Message Handler
 * Handles Midjourney bot messages and downloads generated media
 */

const axios = require('axios');
const logger = require('../utils/logger');
const { uploadToCloudinary } = require('../utils/fileUpload');

class MessageHandler {
  constructor() {
    this.midjourneyBotId = process.env.MIDJOURNEY_BOT_ID || '936929561302675456';
    this.pendingRequests = new Map(); // Track pending generation requests
  }

  /**
   * Handle incoming message from Discord
   * @param {Object} message - Discord message object
   */
  async handle(message) {
    try {
      // Only process messages from Midjourney bot
      if (message.author.id !== this.midjourneyBotId) {
        return;
      }

      // Check if message has attachments (generated media)
      if (message.attachments.size === 0) {
        return;
      }

      logger.info('Midjourney media detected!');

      // Process each attachment
      for (const [, attachment] of message.attachments) {
        await this.processAttachment(attachment, message);
      }
    } catch (error) {
      logger.error('Error handling message:', error.message);
    }
  }

  /**
   * Process media attachment
   * @param {Object} attachment - Discord attachment
   * @param {Object} message - Original message
   */
  async processAttachment(attachment, message) {
    try {
      const { url, name, contentType } = attachment;

      logger.info(`Processing attachment: ${name}`);
      logger.info(`URL: ${url}`);
      logger.info(`Type: ${contentType}`);

      // Determine media type
      const mediaType = this.getMediaType(contentType, name);

      if (!mediaType) {
        logger.warn(`Unknown media type: ${contentType}`);
        return;
      }

      // Download media
      logger.info(`Downloading ${mediaType}...`);
      const mediaBuffer = await this.downloadMedia(url);
      logger.info(`Downloaded ${mediaBuffer.length} bytes`);

      // Optional: Upload to Cloudinary
      // const cloudinaryResult = await uploadToCloudinary(mediaBuffer, mediaType);
      // logger.info(`Uploaded to Cloudinary: ${cloudinaryResult.url}`);

      // Store media info for backend to retrieve
      const mediaInfo = {
        url: url,
        type: mediaType,
        filename: name,
        contentType: contentType,
        size: mediaBuffer.length,
        downloadedAt: new Date().toISOString(),
        messageId: message.id,
        prompt: this.extractPrompt(message.content)
      };

      // TODO: Send to backend API or store in Firebase
      logger.info('Media processing completed');

      return mediaInfo;
    } catch (error) {
      logger.error('Error processing attachment:', error.message);
      throw error;
    }
  }

  /**
   * Download media from URL
   * @param {string} url - Media URL
   * @returns {Promise<Buffer>} Media buffer
   */
  async downloadMedia(url) {
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 60000, // 60 seconds
        maxContentLength: 50 * 1024 * 1024 // 50MB max
      });

      return Buffer.from(response.data);
    } catch (error) {
      logger.error('Error downloading media:', error.message);
      throw new Error(`Failed to download media: ${error.message}`);
    }
  }

  /**
   * Determine media type from content type or filename
   * @param {string} contentType - MIME type
   * @param {string} filename - File name
   * @returns {string|null} 'image' or 'video'
   */
  getMediaType(contentType, filename) {
    // Check content type
    if (contentType) {
      if (contentType.startsWith('image/')) {
        return 'image';
      } else if (contentType.startsWith('video/')) {
        return 'video';
      }
    }

    // Check filename extension
    const ext = filename.split('.').pop().toLowerCase();
    const imageExts = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
    const videoExts = ['mp4', 'mov', 'webm', 'avi'];

    if (imageExts.includes(ext)) {
      return 'image';
    } else if (videoExts.includes(ext)) {
      return 'video';
    }

    return null;
  }

  /**
   * Extract prompt from message content
   * @param {string} content - Message content
   * @returns {string|null} Extracted prompt
   */
  extractPrompt(message.content) {
    // Midjourney messages often contain the prompt
    // Format: "**prompt** - <@userid> (variation/upscale info)"
    const match = content.match(/\*\*(.*?)\*\*/);

    if (match && match[1]) {
      return match[1].trim();
    }

    return content;
  }

  /**
   * Register a pending generation request
   * @param {string} requestId - Unique request ID
   * @param {Object} data - Request data
   */
  registerRequest(requestId, data) {
    this.pendingRequests.set(requestId, {
      ...data,
      createdAt: new Date().toISOString(),
      status: 'pending'
    });

    logger.info(`Registered pending request: ${requestId}`);
  }

  /**
   * Get pending request by ID
   * @param {string} requestId - Request ID
   * @returns {Object|null} Request data
   */
  getRequest(requestId) {
    return this.pendingRequests.get(requestId) || null;
  }

  /**
   * Complete a pending request
   * @param {string} requestId - Request ID
   * @param {Object} result - Completion result
   */
  completeRequest(requestId, result) {
    const request = this.pendingRequests.get(requestId);

    if (request) {
      this.pendingRequests.set(requestId, {
        ...request,
        status: 'completed',
        result: result,
        completedAt: new Date().toISOString()
      });

      logger.info(`Completed request: ${requestId}`);
    }
  }
}

module.exports = new MessageHandler();
