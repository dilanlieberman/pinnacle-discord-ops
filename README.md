# Pinnacle Discord ops bot

How my agency's sales team ran from Discord.

Before this, I had to pull leads and send them to my setters myself; if they had no leads, they couldn't set appointments. This bot made it automatic and instant.

Built with Claude Code. Real commit history (28 Mar – 6 Jun 2026), extracted from my private agency monorepo; secrets and client data removed.

## What's here
- `discord-bot.js`: the bot. Lead-upload commands, `onboard <client>` (starts the onboarding bot), a dry-test channel, the B-roll reel command.
- `ghl-lead-uploader.js`: uploads lead CSVs into GoHighLevel for SMS outreach.
- `pipeline-monitor.js`: webhook that pings the right setter's Discord channel the moment a lead changes stage.
- `announce-whop-payment.js` + `lib/whop-watcher.js` + `lib/win-message.js`: every Whop payment posts to a wins channel.

## Stack
Node.js · Discord.js · GoHighLevel API · Express webhooks · Whop API · runs under PM2 on a Hostinger VPS
