# App Store Connect listing — Hermetic for iPhone

Everything to paste into App Store Connect for the first public submission of the phone app
(Apple ID `6823667364`, bundle ID `com.hermetic.mobile`, version `0.1.0`). Field limits are Apple's;
the counts were checked when this file was written. The privacy policy text is in
[`PRIVACY.md`](PRIVACY.md), screenshots are under [`screenshots/`](screenshots/) and the icon is
[`icon/AppIcon-1024.png`](icon/AppIcon-1024.png).

## App Information (App Store Connect › App Information)

| Field | Value |
| --- | --- |
| Name (30) | `Hermetic` |
| Subtitle (30) | `Chat with your Hermes agents` |
| Bundle ID | `com.hermetic.mobile` |
| Primary category | Developer Tools |
| Secondary category | Productivity |
| Content rights | Does not contain, show or access third-party content (the agent's browser shows pages the operator's own agent opens; see Age Rating) |
| Age rating | See [Age rating](#age-rating) |

## Pricing and Availability

- Price: Free (USD 0). No in-app purchases, no subscriptions.
- Availability: all countries/regions (narrow it if you prefer).
- Apple Silicon Mac / Apple Vision Pro availability: **uncheck** both. The app is built and tested
  for iPhone only (`supportsTablet: false`).

## Version information (iOS App › 0.1.0)

### Promotional text (170)

```
Talk to every Hermes agent in your fleet from your iPhone. Answer approvals, read replies and get a push when an agent needs you, all over your own Tailscale network.
```

### Description (4000)

```
Hermetic is the iPhone companion for a Hermetic fleet: the Hermes AI agents you run in your own AWS account. It talks to your agents directly over your Tailscale network, so you can stay in the conversation while they work, with your laptop closed.

CHAT WITH ANY AGENT
Open any bot on any agent you listen to and pick up the conversation where the desktop left it. Replies render in full: tables, code with a copy button, images, links and tool calls. Start a separate session from the + button when you want a fresh thread, attach a photo or a file, or create a new bot on one of your agents.

UNBLOCK AN AGENT FROM ANYWHERE
When an agent stops to ask for approval before running a command, or asks you a question, answer it right in the conversation with the same choices the desktop offers: approve once, allow for the session, always allow, or deny. Stop a turn that is going the wrong way.

PUSHES FROM YOUR OWN BOXES
Each agent watches its own sessions and sends the notification itself when it replies, fails or needs you. A bot waiting on you is sent as a high-priority push, and tapping it opens the conversation. By default the lock screen names only the bot, never what was said; message previews are opt-in.

ONE SCREEN FOR THE WHOLE FLEET
Pin the bots you talk to most. Everything else sits under its agent, with anything that needs you first, then unread, then most recent. Search across bot names, titles and last messages. See every agent's status and version at a glance, and open the browser an agent is driving.

NOTHING TO STEAL ON THE PHONE
The app holds no AWS credential and no API key. It reaches your agents only because the iPhone is signed in to your tailnet, and every connection runs inside Tailscale's encrypted tunnel. Remove the phone from the tailnet and every way in ends with it. There is no Hermetic server in the middle, no account, no analytics and no tracking.

WHAT YOU NEED
- A Hermetic fleet (free and open source, https://github.com/esopian/hermetic) running in your AWS account.
- The Tailscale app on this iPhone, signed in to the same tailnet as your fleet.
- The desktop app or CLI to show the pairing code: Settings › Pair a phone, or "hermetic mobile pair". The code carries no secret.

Creating or destroying agents, provider keys and upgrades stay on the desktop app and the CLI, which keeps the phone free of credentials.
```

### Keywords (100)

```
AI agent,Hermes,Tailscale,LLM,assistant,self-hosted,AWS,fleet,approvals,chatbot,DevOps,remote
```

### Support URL

`https://github.com/esopian/hermetic/issues`

### Marketing URL (optional)

The site's `/mobile/` page once it is on its production domain. Leave blank until then (the
GitHub repository also works: `https://github.com/esopian/hermetic`).

### Privacy Policy URL

`https://github.com/esopian/hermetic/blob/master/mobile/store/PRIVACY.md` — live once this file is
merged to `master`. Apple checks that the URL loads, so merge first, or host the same text on the
site and use that URL instead.

### Copyright

`2026 Evan Mallory` (or the legal entity that publishes the app)

### What's New in This Version (first release)

```
The first release of Hermetic for iPhone: chat with every Hermes agent in your fleet, answer approvals and questions, attach photos and files, and get pushes straight from your agents, all over your own Tailscale network.
```

## Screenshots

Apple requires one iPhone set; the 6.9" display set (1320 × 2868 portrait) is accepted for every
smaller iPhone, so it is the only one to upload. Up to 10 per set; order matters, the first three
show in search results.

| # | File | Shows |
| --- | --- | --- |
| 1 | `01-home.png` | Home: pinned bots, needs-you marks, bots grouped by agent |
| 2 | `02-chat-approval.png` | An approval card mid-turn |
| 3 | `03-chat-md.png` | A rich reply: table, code block, image |
| 4 | `04-chat-tools.png` | A plain conversation |
| 5 | `05-settings-notif.png` | Notification and appearance settings |
| 6 | `06-settings.png` | Agent list with status |
| 7 | `07-home-light.png` | Home in light mode |

`screenshots/6.9-captioned/` has each one framed with a headline (recommended for the listing);
`screenshots/6.9-raw/` has the bare simulator captures. All are RGB PNG with no alpha, captured on
the iPhone 16 Pro Max simulator (iOS 18.3) against the fixture fleet with a 9:41 status bar. Two raw
captures had the fixture's trigger word painted out of the operator's message. Regenerate with the
fixture app (`EXPO_PUBLIC_HERMETIC_FIXTURE=1 bun run ios`), `xcrun simctl io <udid> screenshot`, and
`SHOTS_DIR=<captures> python3 compose-screenshots.py` (Pillow).

## App icon

`icon/AppIcon-1024.png`: 1024 × 1024, RGB, no alpha, no rounded corners (iOS applies the mask). It is
a copy of `mobile/assets/icon.png`, which the build already embeds; App Store Connect takes the
store icon from the uploaded binary, so this copy is only needed where a form asks for it.

## App Privacy (App Store Connect › App Privacy)

Recommended answer: **Data Not Collected.**

Apple counts data as "collected" when it is sent off the device to the developer or a third-party
partner and kept longer than needed to serve the request. Hermetic's developer runs no server for the
app and receives nothing from it:

- Chat messages and attachments go to the operator's own agent, in the operator's own AWS account,
  over the operator's own tailnet. The developer cannot access them.
- The push token is registered with the operator's own agents, which send pushes through Expo's push
  service and APNs only to deliver them. With previews off (the default) a push carries only the
  bot's name.
- No analytics, advertising, crash-reporting or tracking SDK is included. The support report is
  generated on the device and only shared if the user chooses to.

If you prefer a more conservative label because pushes transit Expo's service, declare
**Identifiers › Device ID** (the push token) and, for opted-in previews, **User Content › Other User
Content**, each as *App Functionality*, *not linked to the user*, *not used for tracking*.

Tracking: **No** — the app does not track. No App Tracking Transparency prompt is needed.

## Age rating

Answer the questionnaire honestly; these are the answers that apply:

| Question | Answer |
| --- | --- |
| Violence, sexual content, profanity, horror, drugs, gambling, contests, medical | None |
| Unrestricted web access | **Yes** — the agent browser view shows a full remote Chrome session the agent (and the user) can drive to any site |
| User-generated content / messaging between users | No (the user talks to their own agents, not to other people) |
| AI chatbot / generative AI features (if asked) | Yes — the app is a client for the user's own AI agents |
| Made for Kids | No |

Unrestricted web access sets the rating to **18+** under Apple's current scale. That is expected for
an app with a general browser view.

## Export compliance

`ITSAppUsesNonExemptEncryption` is `false` in `app.config.ts`, so App Store Connect will not ask
per build. The app uses only the encryption built into iOS (HTTPS/TLS) and relies on the separate
Tailscale app for its tunnel.

## App Review Information

| Field | Value |
| --- | --- |
| Sign-in required | Yes — see notes (a demo fleet and a Tailscale reviewer login, not a Hermetic account) |
| Contact | your name, phone and email |
| Demo account user name | the Tailscale reviewer login (e.g. a dedicated Google or GitHub account you add to the tailnet) |
| Demo account password | that account's password |
| Attachment | a 60–90 s screen recording of pairing, home, a chat and an approval on a real device |

### Notes for the reviewer (4000)

```
Hermetic is a companion app for Hermetic, an open-source tool (https://github.com/esopian/hermetic) that runs Hermes AI agents in the user's own AWS account. The phone app has no account of its own and talks to the user's agents directly over the user's private Tailscale network. It needs:
1. The Tailscale app (free, App Store) signed in to the fleet's tailnet.
2. A pairing link produced by the user's Hermetic installation.

We have set up a review fleet for you:
1. Install Tailscale from the App Store and sign in with the demo account above. Allow the VPN configuration when Tailscale asks.
2. Open Hermetic. On "Pair this phone", paste this link into the field under "Or paste the link" and tap Read link, then Pair:
   <PASTE THE REVIEW FLEET'S hermetic://fleet?v=3&... LINK HERE>
   (The link carries no secret. It names the fleet and its agents.)
3. Pick "<review agent name>" as the primary instance and tap Continue.
4. Tap a bot to chat. Ask it anything. To see an approval, ask it to run a shell command such as "list the files in /tmp".

Permissions: the camera is used only to scan the pairing QR code (the paste field above avoids it) and to attach a photo you take; photo library access only when you attach a photo; notifications for replies and approval requests from your agents.

The app collects no data: messages go only to the user's own agents. A screen recording is attached in case the review network cannot reach Tailscale.
```

### Before you submit: the review fleet

Apple's reviewer cannot use the app without a reachable fleet, and a missing or broken demo is the
most common rejection (Guideline 2.1). Before submitting:

1. Keep one small agent running for the review period (a `t4g.small` is enough).
2. Create a dedicated identity for the reviewer and invite it to the tailnet as a member. Make sure
   the tailnet ACL lets `autogroup:member` reach `tag:hermetic` on 443 and 7434 (Hermetic's default).
3. Run `hermetic mobile pair` and paste its link into the notes above.
4. Walk through the notes yourself on a clean phone with that identity.
5. Remove the reviewer from the tailnet after approval.

## Checklist

- [ ] Production build uploaded (`bun run build:production`, then `bun run submit:testflight --id <uuid>`) and processed
- [ ] Build selected on the 0.1.0 version page
- [ ] Privacy policy URL loads
- [ ] App Privacy answered and published
- [ ] Age rating questionnaire done
- [ ] Review fleet up, demo login and pairing link in App Review Information
- [ ] Screenshots uploaded (6.9")
- [ ] Submit for review
