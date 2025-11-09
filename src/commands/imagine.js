/**
 * Imagine Command
 * Sends /imagine command to Midjourney for image/video generation
 */

const logger = require('../utils/logger');

class ImagineCommand {
  /**
   * Send imagine command to Midjourney
   * @param {Object} client - Discord client
   * @param {string} channelId - Channel ID
   * @param {string} prompt - Midjourney prompt
   * @returns {Promise<Object>} Command result
   */
  async execute(client, channelId, prompt) {
    try {
      logger.info(`Sending imagine command: ${prompt.substring(0, 60)}...`);

      // Get channel
      const channel = await client.channels.fetch(channelId);

      if (!channel) {
        throw new Error(`Channel not found: ${channelId}`);
      }

      // Send /imagine command to Midjourney
      // Note: This requires Midjourney bot to be in the channel
      const message = `/imagine ${prompt}`;

      await channel.send(message);

      logger.info('Imagine command sent successfully');

      return {
        success: true,
        channelId: channelId,
        prompt: prompt,
        sentAt: new Date().toISOString()
      };
    } catch (error) {
      logger.error('Error sending imagine command:', error.message);
      throw new Error(`Failed to send imagine command: ${error.message}`);
    }
  }

  /**
   * Send imagine command with retry logic
   * @param {Object} client - Discord client
   * @param {string} channelId - Channel ID
   * @param {string} prompt - Midjourney prompt
   * @param {number} maxRetries - Maximum retries
   * @returns {Promise<Object>} Command result
   */
  async executeWithRetry(client, channelId, prompt, maxRetries = 3) {
    let attempt = 0;
    let lastError;

    while (attempt < maxRetries) {
      try {
        attempt++;
        logger.info(`Imagine command attempt ${attempt}/${maxRetries}`);

        const result = await this.execute(client, channelId, prompt);
        return result;
      } catch (error) {
        lastError = error;
        logger.warn(`Attempt ${attempt} failed: ${error.message}`);

        if (attempt < maxRetries) {
          const delay = attempt * 2000; // 2s, 4s, 6s
          logger.info(`Retrying in ${delay / 1000}s...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw new Error(`Failed after ${maxRetries} attempts: ${lastError.message}`);
  }
}

module.exports = new ImagineCommand();
