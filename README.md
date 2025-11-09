# Doors22 Discord Bot

Discord bot for Midjourney integration. Sends prompts to Midjourney and monitors for generated images.

## Features

- Send prompts to Midjourney
- Monitor for image completion
- Download generated images
- Upload to Cloudinary
- Store metadata in Firebase

## Setup

Install dependencies:
```bash
npm install
```

Configure environment:
```bash
cp .env.example .env
# Fill in your credentials
```

Run bot:
```bash
npm start
```

Development mode:
```bash
npm run dev
```

## Deploy to Railway

Railway will auto-deploy from GitHub on push to main branch.

Environment variables must be configured in Railway dashboard.
