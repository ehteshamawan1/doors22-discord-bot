/**
 * Express API Server for Discord Bot
 * Provides HTTP endpoints for the backend to interact with Midjourney via Discord
 */

const express = require('express');
const cors = require('cors');

class APIServer {
  constructor(discordClient) {
    this.app = express();
    this.client = discordClient;
    this.port = process.env.PORT || 3002;

    // Store pending and completed requests
    this.pendingRequests = new Map();
    this.completedRequests = new Map();

    this.setupMiddleware();
    this.setupRoutes();
  }

  setupMiddleware() {
    this.app.use(cors());
    this.app.use(express.json());

    // Request logging
    this.app.use((req, res, next) => {
      console.log(`[API] ${req.method} ${req.path}`);
      next();
    });
  }

  setupRoutes() {
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'ok',
        bot: this.client.user ? 'connected' : 'disconnected',
        botTag: this.client.user?.tag,
        uptime: process.uptime()
      });
    });

    // Root endpoint
    this.app.get('/', (req, res) => {
      res.json({
        service: 'Doors22 Discord Bot API',
        status: 'running',
        bot: this.client.user?.tag || 'not connected'
      });
    });

    // Send imagine command to Midjourney
    this.app.post('/api/midjourney/imagine', async (req, res) => {
      try {
        const { prompt, type, channelId } = req.body;

        if (!prompt) {
          return res.status(400).json({
            success: false,
            error: 'Prompt is required'
          });
        }

        // Get the channel
        const targetChannelId = channelId || process.env.DISCORD_CHANNEL_ID;
        console.log(`[API] Fetching channel: ${targetChannelId}`);

        const channel = await this.client.channels.fetch(targetChannelId);

        if (!channel) {
          return res.status(404).json({
            success: false,
            error: 'Channel not found'
          });
        }

        // Send the imagine command
        console.log(`[API] Sending imagine command: ${prompt.substring(0, 100)}...`);
        const message = await channel.send(`/imagine prompt: ${prompt}`);

        // Generate request ID
        const requestId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Store request
        this.pendingRequests.set(requestId, {
          requestId,
          prompt,
          type,
          status: 'pending',
          messageId: message.id,
          channelId: channel.id,
          sentAt: new Date().toISOString()
        });

        console.log(`[API] Request ${requestId} created and stored`);

        res.json({
          success: true,
          requestId,
          message: 'Imagine command sent to Midjourney'
        });

      } catch (error) {
        console.error('[API] Error sending imagine command:', error);
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    // Get status of a request
    this.app.get('/api/midjourney/status/:requestId', (req, res) => {
      const { requestId } = req.params;

      // Check completed requests first
      if (this.completedRequests.has(requestId)) {
        return res.json(this.completedRequests.get(requestId));
      }

      // Check pending requests
      if (this.pendingRequests.has(requestId)) {
        return res.json(this.pendingRequests.get(requestId));
      }

      res.status(404).json({
        success: false,
        status: 'not_found',
        error: 'Request not found'
      });
    });

    // Cancel a request
    this.app.post('/api/midjourney/cancel', (req, res) => {
      const { requestId } = req.body;

      if (this.pendingRequests.has(requestId)) {
        this.pendingRequests.delete(requestId);
        console.log(`[API] Request ${requestId} cancelled`);

        res.json({
          success: true,
          message: 'Request cancelled'
        });
      } else {
        res.status(404).json({
          success: false,
          error: 'Request not found or already completed'
        });
      }
    });

    // List all requests (for debugging)
    this.app.get('/api/midjourney/requests', (req, res) => {
      res.json({
        pending: Array.from(this.pendingRequests.values()),
        completed: Array.from(this.completedRequests.values()).slice(-10) // Last 10 completed
      });
    });
  }

  /**
   * Mark a request as completed
   * Called by the message handler when Midjourney responds
   */
  completeRequest(requestId, mediaUrl) {
    if (this.pendingRequests.has(requestId)) {
      const request = this.pendingRequests.get(requestId);
      request.status = 'completed';
      request.mediaUrl = mediaUrl;
      request.completedAt = new Date().toISOString();

      this.completedRequests.set(requestId, request);
      this.pendingRequests.delete(requestId);

      console.log(`[API] Request ${requestId} completed with media: ${mediaUrl}`);
    }
  }

  /**
   * Mark a request as failed
   */
  failRequest(requestId, error) {
    if (this.pendingRequests.has(requestId)) {
      const request = this.pendingRequests.get(requestId);
      request.status = 'failed';
      request.error = error;
      request.failedAt = new Date().toISOString();

      this.completedRequests.set(requestId, request);
      this.pendingRequests.delete(requestId);

      console.error(`[API] Request ${requestId} failed:`, error);
    }
  }

  /**
   * Find request by message ID (for matching Midjourney responses)
   */
  findRequestByMessageId(messageId) {
    for (const [requestId, request] of this.pendingRequests.entries()) {
      if (request.messageId === messageId) {
        return requestId;
      }
    }
    return null;
  }

  start() {
    this.app.listen(this.port, '0.0.0.0', () => {
      console.log(`✅ API Server listening on port ${this.port}`);
      console.log(`📡 Health check: http://localhost:${this.port}/health`);
    });
  }
}

module.exports = APIServer;
