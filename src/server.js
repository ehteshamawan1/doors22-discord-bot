/**
 * Express API Server for Discord Bot
 * Provides HTTP endpoints for the backend to interact with Midjourney via Discord
 */

const express = require('express');
const cors = require('cors');
const { Midjourney } = require('midjourney');

class APIServer {
  constructor(discordClient) {
    this.app = express();
    this.client = discordClient;
    this.port = process.env.PORT || 3002;

    // Initialize Midjourney API client
    this.midjourney = new Midjourney({
      ServerId: process.env.DISCORD_GUILD_ID,
      ChannelId: process.env.DISCORD_CHANNEL_ID,
      SalaiToken: process.env.DISCORD_USER_TOKEN,
      Debug: true,
      Ws: true
    });

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
        const { prompt, type } = req.body;

        if (!prompt) {
          return res.status(400).json({
            success: false,
            error: 'Prompt is required'
          });
        }

        console.log(`[API] Generating ${type || 'image'} with Midjourney: ${prompt.substring(0, 100)}...`);

        // Generate request ID
        const requestId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Store request as pending
        this.pendingRequests.set(requestId, {
          requestId,
          prompt,
          type,
          status: 'pending',
          sentAt: new Date().toISOString()
        });

        // For video: First generate image, then convert to video
        if (type === 'video') {
          console.log(`[API] Step 1/2: Generating base image for video...`);

          // Remove video-specific parameters from prompt for image generation
          const imagePrompt = prompt.replace(/--video/g, '').replace(/--ar 9:16/g, '--ar 4:5').trim();

          this.midjourney.Imagine(imagePrompt, async (uri, progress) => {
            console.log(`[Midjourney] Image generation progress: ${progress}% - ${uri}`);

            // Check if 4-grid image is complete (final PNG with username)
            if (uri && uri.includes('doors_22__78435') && uri.endsWith('.png')) {
              console.log(`[API] Step 1/2 Complete: 4-image grid generated: ${uri}`);
              console.log(`[API] Step 2/2: Generating video with base image...`);

              try {
                // Generate video with 4-grid image as start frame
                const videoPrompt = `${uri} ${prompt}`;

                this.midjourney.Imagine(videoPrompt, (videoUri, videoProgress) => {
                  console.log(`[Midjourney] Video generation progress: ${videoProgress}% - ${videoUri}`);

                  if (videoUri && videoProgress === 100) {
                    console.log(`[API] Request ${requestId} completed with video: ${videoUri}`);
                    this.completeRequest(requestId, videoUri);
                  }
                }).catch(error => {
                  console.error(`[Midjourney] Video generation error:`, error.message);
                  this.failRequest(requestId, error.message);
                });
              } catch (error) {
                console.error(`[API] Error starting video generation:`, error);
                this.failRequest(requestId, error.message);
              }
            }
          }).catch(error => {
            console.error(`[Midjourney] Image generation error for request ${requestId}:`, error.message);
            this.failRequest(requestId, error.message);
          });
        } else {
          // Regular image generation
          this.midjourney.Imagine(prompt, async (uri, progress) => {
            console.log(`[Midjourney] Image progress: ${progress}% - ${uri}`);

            // Midjourney generates 4-image grid - check if it's the final PNG (not webp preview)
            if (uri && uri.includes('doors_22__78435') && uri.endsWith('.png')) {
              // This is the final 4-image grid
              console.log(`[API] 4-image grid generated: ${uri}`);

              // For images, return the 4-grid directly
              console.log(`[API] Request ${requestId} completed with 4-grid image: ${uri}`);
              this.completeRequest(requestId, uri);
            }
          }).catch(error => {
            console.error(`[Midjourney] Error for request ${requestId}:`, error.message);
            this.failRequest(requestId, error.message);
          });
        }

        console.log(`[API] Request ${requestId} created and sent to Midjourney`);

        res.json({
          success: true,
          requestId,
          message: `${type === 'video' ? 'Video' : 'Image'} generation started`
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

  /**
   * Extract hash from Midjourney image URI
   */
  extractHashFromUri(uri) {
    // Extract hash from URI like: ...doors_22__78435_..._HASH.png
    const match = uri.match(/_([a-f0-9-]+)\.(png|webp)/i);
    return match ? match[1] : null;
  }

  start() {
    this.app.listen(this.port, '0.0.0.0', () => {
      console.log(`✅ API Server listening on port ${this.port}`);
      console.log(`📡 Health check: http://localhost:${this.port}/health`);
    });
  }
}

module.exports = APIServer;
