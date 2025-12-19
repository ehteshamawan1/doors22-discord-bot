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
        const { prompt, type, manualUpscale } = req.body;

        if (!prompt) {
          return res.status(400).json({
            success: false,
            error: 'Prompt is required'
          });
        }

        console.log(`[API] Generating ${type || 'image'} with Midjourney: ${prompt.substring(0, 100)}...`);

        // Generate request ID
        const requestId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Store request as pending (will update with message ID after sending)
        this.pendingRequests.set(requestId, {
          requestId,
          prompt,
          type,
          manualUpscale: Boolean(manualUpscale),
          status: 'pending',
          sentAt: new Date().toISOString(),
          promptSubstring: prompt.substring(0, 50) // For matching Discord messages
        });

        // For video: First generate image, then convert to video
        if (type === 'video') {
          console.log(`[API] Step 1/2: Generating base image for video...`);

          // Remove video-specific parameters from prompt for image generation
          const imagePrompt = prompt.replace(/--video/g, '').replace(/--ar 9:16/g, '--ar 4:5').trim();

          // Update request with image prompt for matching
          const request = this.pendingRequests.get(requestId);
          request.currentStep = 'image';
          request.imagePrompt = imagePrompt;

          this.midjourney.Imagine(imagePrompt, async (uri, progress) => {
            console.log(`[Midjourney] Image generation progress: ${progress}% - ${uri}`);

            // Discord message handler will detect completion and trigger step 2
          }).catch(error => {
            console.error(`[Midjourney] Image generation error for request ${requestId}:`, error.message);
            this.failRequest(requestId, error.message);
          });
        } else {
          // Regular image generation
          this.midjourney.Imagine(prompt, async (uri, progress) => {
            console.log(`[Midjourney] Image progress: ${progress}% - ${uri}`);

            // Discord message handler will detect completion
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

    /**
     * Click a button on a Midjourney message (U1-U4, V1-V4, etc.)
     * Used for video generation workflow: upscale → animate → select
     */
    this.app.post('/api/midjourney/button', async (req, res) => {
      try {
        const { messageId, buttonId, channelId, expectedType } = req.body;

        if (!messageId || !buttonId) {
          return res.status(400).json({
            success: false,
            error: 'messageId and buttonId are required'
          });
        }

        console.log(`[API] Clicking button ${buttonId} on message ${messageId}`);

        // Generate request ID for tracking
        const requestId = `btn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Fetch the message to get button info
        const channel = await this.client.channels.fetch(channelId || process.env.DISCORD_CHANNEL_ID);
        const message = await channel.messages.fetch(messageId);

        if (!message.components || message.components.length === 0) {
          return res.status(400).json({
            success: false,
            error: 'Message has no interactive components'
          });
        }

        // Find the button by label
        let targetButton = null;
        for (const row of message.components) {
          for (const component of row.components) {
            if (component.label === buttonId || component.customId?.includes(buttonId)) {
              targetButton = component;
              break;
            }
          }
          if (targetButton) break;
        }

        if (!targetButton) {
          return res.status(400).json({
            success: false,
            error: `Button ${buttonId} not found on message`
          });
        }

        // Store pending request
        this.pendingRequests.set(requestId, {
          requestId,
          type: 'button_click',
          buttonId,
          expectedType,
          messageId,
          status: 'pending',
          sentAt: new Date().toISOString()
        });

        // Click the button using Midjourney Custom method
        console.log(`[API] Triggering button click: ${targetButton.label || targetButton.customId}`);

        this.midjourney.Custom({
          msgId: messageId,
          flags: message.flags || 0,
          customId: targetButton.customId || targetButton.custom_id,
          content: '',
          loading: (uri, progress) => {
            console.log(`[Midjourney] Button action progress: ${progress}% - ${uri}`);
          }
        }).catch(error => {
          console.error(`[Midjourney] Button click error:`, error.message);
          this.failRequest(requestId, error.message);
        });

        res.json({
          success: true,
          requestId,
          message: `Button ${buttonId} click initiated`
        });

      } catch (error) {
        console.error('[API] Error clicking button:', error);
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    /**
     * Trigger animate feature on an upscaled image
     * This creates a 5-10 second video from a static image
     */
    this.app.post('/api/midjourney/animate', async (req, res) => {
      try {
        const { messageId, channelId } = req.body;

        if (!messageId) {
          return res.status(400).json({
            success: false,
            error: 'messageId is required'
          });
        }

        console.log(`[API] Triggering animate on message ${messageId}`);

        // Generate request ID for tracking
        const requestId = `anim_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Fetch the message to find animate button
        const channel = await this.client.channels.fetch(channelId || process.env.DISCORD_CHANNEL_ID);
        const message = await channel.messages.fetch(messageId);

        if (!message.components || message.components.length === 0) {
          return res.status(400).json({
            success: false,
            error: 'Message has no interactive components'
          });
        }

        // Find the animate button (prefer high motion if available)
        let animateButton = null;
        const allButtons = message.components.flatMap(row => row.components);
        const getLabel = (component) => (component.label || '').toLowerCase();
        const getCustomId = (component) => (component.customId || component.custom_id || '').toLowerCase();
        const isAnimate = (component) => {
          const label = getLabel(component);
          const customId = getCustomId(component);
          return (
            label.includes('animate') ||
            label.includes('video') ||
            customId.includes('animate') ||
            customId.includes('video') ||
            component.emoji?.name?.includes('video')
          );
        };
        const isHigh = (component) => {
          const label = getLabel(component);
          const customId = getCustomId(component);
          return label.includes('high') || customId.includes('animate_high');
        };
        const isLow = (component) => {
          const label = getLabel(component);
          const customId = getCustomId(component);
          return label.includes('low') || customId.includes('animate_low');
        };

        const animateCandidates = allButtons.filter(isAnimate);
        if (animateCandidates.length > 0) {
          const highCandidate = animateCandidates.find(isHigh);
          const lowCandidate = animateCandidates.find(isLow);
          animateButton = highCandidate || lowCandidate || animateCandidates[0];
          console.log(`[API] Animate candidates: ${animateCandidates.map(c => c.label || c.customId).join(', ')}`);
          console.log(`[API] Selected animate button: ${animateButton.label || animateButton.customId}`);
        }

        if (!animateButton) {
          return res.status(400).json({
            success: false,
            error: 'Animate button not found on message. Available buttons: ' +
                   message.components.flatMap(row =>
                     row.components.map(c => c.label || c.customId)
                   ).join(', ')
          });
        }

        // Store pending request
        this.pendingRequests.set(requestId, {
          requestId,
          type: 'animate',
          messageId,
          expectedType: 'video',
          status: 'pending',
          currentStep: 'animating',
          sentAt: new Date().toISOString()
        });

        // Trigger animate using Custom method
        console.log(`[API] Triggering animate: ${animateButton.label || animateButton.customId}`);

        this.midjourney.Custom({
          msgId: messageId,
          flags: message.flags || 0,
          customId: animateButton.customId || animateButton.custom_id,
          content: '',
          loading: (uri, progress) => {
            console.log(`[Midjourney] Animate progress: ${progress}% - ${uri}`);
          }
        }).catch(error => {
          console.error(`[Midjourney] Animate error:`, error.message);
          this.failRequest(requestId, error.message);
        });

        res.json({
          success: true,
          requestId,
          message: 'Animate initiated'
        });

      } catch (error) {
        console.error('[API] Error triggering animate:', error);
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });
  }

  /**
   * Handle image upscaling - randomly select U1-U4
   */
  async handleImageUpscale(requestId, imageUrl, message) {
    if (!this.pendingRequests.has(requestId)) {
      console.log(`[API] Request ${requestId} not found in pending requests`);
      return;
    }

    try {
      const request = this.pendingRequests.get(requestId);
      const buttons = message.components[0].components;
      const upscaleButtons = buttons.filter(btn => ['U1', 'U2', 'U3', 'U4'].includes(btn.label));

      if (upscaleButtons.length === 0) {
        console.log(`[API] No upscale buttons found, completing without upscale`);
        await this.handleImageComplete(requestId, imageUrl);
        return;
      }

      // Randomly select one upscale button
      const randomButton = upscaleButtons[Math.floor(Math.random() * upscaleButtons.length)];
      console.log(`[API] Selected ${randomButton.label} for upscaling`);
      console.log(`[API] Button data:`, JSON.stringify(randomButton, null, 2));

      // Update request status - different states for image vs video
      if (request.type === 'video') {
        request.currentStep = 'upscale_base_image';
        console.log(`[API] Video request: Waiting for upscaled base image`);
      } else {
        request.currentStep = 'upscaling';
        console.log(`[API] Image request: Waiting for upscaled image`);
      }
      request.gridImageUrl = imageUrl;
      request.selectedButton = randomButton.label;

      // Extract upscale index from label (U1 = 1, U2 = 2, etc.)
      const upscaleIndex = parseInt(randomButton.label.replace('U', ''));

      // Trigger upscale using Custom method with proper custom_id
      console.log(`[API] Triggering upscale with button: ${randomButton.label}`);
      console.log(`[API] Message ID: ${message.id}`);
      console.log(`[API] Custom ID: ${randomButton.customId || randomButton.custom_id}`);

      this.midjourney.Custom({
        msgId: message.id,
        flags: message.flags || 0,
        customId: randomButton.customId || randomButton.custom_id,
        content: request.prompt || '',
        loading: (uri, progress) => {
          console.log(`[Midjourney] Upscale progress: ${progress}% - ${uri}`);
        }
      }).catch(error => {
        console.error(`[Midjourney] Upscale error:`, error.message);
        // Fallback to grid image if upscale fails
        this.handleImageComplete(requestId, imageUrl);
      });
    } catch (error) {
      console.error(`[API] Error handling image upscale:`, error);
      // Fallback to completing with grid image
      await this.handleImageComplete(requestId, imageUrl);
    }
  }

  /**
   * Handle video upscaling - randomly select U1-U4 for video
   */
  async handleVideoUpscale(requestId, videoUrl, message) {
    if (!this.pendingRequests.has(requestId)) {
      console.log(`[API] Request ${requestId} not found in pending requests`);
      return;
    }

    try {
      const request = this.pendingRequests.get(requestId);
      const buttons = message.components[0].components;
      const upscaleButtons = buttons.filter(btn => ['U1', 'U2', 'U3', 'U4'].includes(btn.label));

      if (upscaleButtons.length === 0) {
        console.log(`[API] No upscale buttons found for video, completing without upscale`);
        this.completeRequest(requestId, videoUrl);
        return;
      }

      // Randomly select one upscale button
      const randomButton = upscaleButtons[Math.floor(Math.random() * upscaleButtons.length)];
      console.log(`[API] Selected ${randomButton.label} for video upscaling`);
      console.log(`[API] Button data:`, JSON.stringify(randomButton, null, 2));

      // Update request status
      request.currentStep = 'upscaling_video';
      request.gridVideoUrl = videoUrl;
      request.selectedButton = randomButton.label;

      // Trigger upscale using Custom method with proper custom_id
      console.log(`[API] Triggering video upscale with button: ${randomButton.label}`);
      console.log(`[API] Message ID: ${message.id}`);
      console.log(`[API] Custom ID: ${randomButton.customId || randomButton.custom_id}`);

      this.midjourney.Custom({
        msgId: message.id,
        flags: message.flags || 0,
        customId: randomButton.customId || randomButton.custom_id,
        content: request.prompt || '',
        loading: (uri, progress) => {
          console.log(`[Midjourney] Video upscale progress: ${progress}% - ${uri}`);
        }
      }).catch(error => {
        console.error(`[Midjourney] Video upscale error:`, error.message);
        // Fallback to grid video if upscale fails
        this.completeRequest(requestId, videoUrl);
      });
    } catch (error) {
      console.error(`[API] Error handling video upscale:`, error);
      // Fallback to completing with grid video
      this.completeRequest(requestId, videoUrl);
    }
  }

  /**
   * Handle upscaled image completion - continue to video generation or complete image request
   */
  async handleUpscaledImageComplete(requestId, imageUrl) {
    if (!this.pendingRequests.has(requestId)) {
      console.log(`[API] Request ${requestId} not found in pending requests`);
      return;
    }

    const request = this.pendingRequests.get(requestId);
    console.log(`[API] Upscaled image received for ${request.type} request`);

    // If this is for video generation, start video generation with upscaled image
    if (request.type === 'video') {
      console.log(`[API] Step 1.5/3 Complete: Base image upscaled: ${imageUrl}`);
      console.log(`[API] Step 2/3: Generating video with upscaled base image...`);

      try {
        // Update request
        request.currentStep = 'video';
        request.baseImageUrl = imageUrl;

        // Generate video with upscaled image as start frame
        const videoPrompt = `${imageUrl} ${request.prompt}`;

        this.midjourney.Imagine(videoPrompt, (videoUri, videoProgress) => {
          console.log(`[Midjourney] Video generation progress: ${videoProgress}% - ${videoUri}`);

          // Discord message handler will detect video completion
        }).catch(error => {
          console.error(`[Midjourney] Video generation error:`, error.message);
          this.failRequest(requestId, error.message);
        });
      } catch (error) {
        console.error(`[API] Error starting video generation:`, error);
        this.failRequest(requestId, error.message);
      }
    } else {
      // Regular image request - complete it with upscaled image
      console.log(`[API] Image upscale complete, finalizing request`);
      this.completeRequest(requestId, imageUrl);
    }
  }

  /**
   * Handle image completion - either complete request or trigger video generation
   */
  async handleImageComplete(requestId, imageUrl) {
    if (!this.pendingRequests.has(requestId)) {
      console.log(`[API] Request ${requestId} not found in pending requests`);
      return;
    }

    const request = this.pendingRequests.get(requestId);

    // If this is for video generation, start step 2
    if (request.type === 'video' && request.currentStep === 'image') {
      console.log(`[API] Step 1/3 Complete: Base image generated (upscaling will follow): ${imageUrl}`);
      // Note: The upscaling will be handled by bot.js when it detects the 4-grid
      // This method is only called if the image doesn't have upscale buttons
      console.log(`[API] Step 2/3: Generating video with base image...`);

      try {
        // Update request
        request.currentStep = 'video';
        request.baseImageUrl = imageUrl;

        // Generate video with image as start frame
        const videoPrompt = `${imageUrl} ${request.prompt}`;

        this.midjourney.Imagine(videoPrompt, (videoUri, videoProgress) => {
          console.log(`[Midjourney] Video generation progress: ${videoProgress}% - ${videoUri}`);

          // Discord message handler will detect video completion
        }).catch(error => {
          console.error(`[Midjourney] Video generation error:`, error.message);
          this.failRequest(requestId, error.message);
        });
      } catch (error) {
        console.error(`[API] Error starting video generation:`, error);
        this.failRequest(requestId, error.message);
      }
    } else {
      // Regular image request - complete it
      this.completeRequest(requestId, imageUrl);
    }
  }

  /**
   * Mark a request as completed
   * Called by the message handler when Midjourney responds
   */
  completeRequest(requestId, mediaUrl, messageId) {
    if (this.pendingRequests.has(requestId)) {
      const request = this.pendingRequests.get(requestId);
      request.status = 'completed';
      request.mediaUrl = mediaUrl;
      if (messageId) {
        request.messageId = messageId;
      }
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


  start() {
    this.app.listen(this.port, '0.0.0.0', () => {
      console.log(`✅ API Server listening on port ${this.port}`);
      console.log(`📡 Health check: http://localhost:${this.port}/health`);
    });
  }
}

module.exports = APIServer;
