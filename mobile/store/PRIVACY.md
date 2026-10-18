# Hermetic for iPhone — Privacy Policy

Effective date: October 17, 2026

Hermetic for iPhone ("the app") is a companion to a Hermetic fleet: Hermes agents that you run in
your own AWS account and reach over your own Tailscale network. This policy explains what the app
handles and where that data goes. The short version: **the developer of Hermetic runs no server
for the app and collects no data from it.**

## What the app does not do

- It has no account with us, and no sign-up.
- It contains no analytics, advertising, tracking or crash-reporting SDK.
- It does not sell or share data with data brokers or advertisers, and it does not track you across
  other companies' apps or websites.
- It does not send any data to the developer of Hermetic.

## Data the app handles, and where it goes

**Pairing details.** When you pair, the app reads a link or QR code produced by your own Hermetic
installation. It contains your fleet's name, its Tailscale network name and a list of your agents.
It carries no password, key or token. The app stores it in the iPhone's keychain, on this device
only. Signing out of the app deletes it.

**Chat messages and attachments.** Messages you send, and photos or files you attach, go directly
from your iPhone to the agent you are talking to, over your Tailscale network, to a server running
in your own AWS account. Transcripts are stored on that agent's own disk, not by us. The agent may
forward your messages to the AI model provider you configured for it (for example Anthropic,
OpenAI or Amazon Bedrock); that provider's own terms and privacy policy apply to that processing.

**Push notifications.** If you allow notifications, the app registers an Expo push token with your
own agents. When an agent needs you or replies, your agent sends the notification through Expo's
push service (operated by 650 Industries, Inc.) and Apple Push Notification service. By default a
notification names only the agent ("corvid replied") and contains nothing of the conversation. If
you turn on message previews in Settings, a redacted excerpt of up to 140 characters is included.
A registration lapses on its own 72 hours after the app last renewed it.

**Camera and photos.** The camera is used to scan the pairing QR code and, if you choose, to take a
photo to attach to a chat. The photo library is opened only when you choose a photo to attach.
Nothing is uploaded except the photo you pick, and only to your own agent.

**Local network.** The app connects to your agents over your Tailscale network. It does not scan or
contact other devices on your local network.

**Preferences and inbox.** Appearance settings, the bots you pin and listen to, and unread markers
are stored on your iPhone only.

**Support report.** Settings › Review support report builds a short diagnostic summary (app version,
iOS version, coarse connection status, error categories). It contains no conversation content,
host names or identifiers. It never leaves the device unless you choose to share it yourself.

## Children

The app is a tool for operating your own software agents and is not directed at children.

## Your choices

You can deny camera, photo or notification access in iOS Settings at any time; the rest of the app
keeps working. Signing out in the app removes the pairing from the device. Deleting the app removes
all data it stored locally. Data on your own agents is under your control in your own AWS account.

## Changes

If this policy changes, the new version will be posted at this address with a new effective date.

## Contact

Questions about this policy: open an issue at https://github.com/esopian/hermetic/issues.
