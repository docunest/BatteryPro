# Private AI Chat

A small, private AI chat app for iPhone. It's an installable web app (PWA): no App Store, no Apple developer account, and no build step.

- **Multiple chats**, with search, rename and delete. **Pin** chats to keep them; unpinned chats are deleted automatically 7 days after their last message (configurable in Settings → Data).
- **Image generation**: ask in plain words ("draw a fox reading a book") and the model calls an image tool. You can also tap 🎨 to send a prompt straight to the image model.
- **Providers**: OpenAI, Anthropic (Claude), DeepSeek, OpenRouter, or any OpenAI-compatible endpoint. Images use the OpenAI Images API (`gpt-image-1`, `dall-e-3`, …).
- **Face ID unlock** (iOS 18+), with a **passcode** as backup
- Works offline as an app shell. Markdown, code blocks and tables are rendered.

## Privacy

| | |
|---|---|
| Storage | Chats, images and settings (including API keys) are stored **only on your device** in IndexedDB. |
| Encryption | Everything is encrypted with a random AES-256-GCM key. That key is wrapped by your passcode (PBKDF2-SHA256, 600k iterations) and, optionally, by a Face ID passkey through the WebAuthn **PRF** extension. Face ID really derives a decryption key; it isn't just a gate in front of the data. |
| Network | Requests go **directly** from your phone to the AI provider you chose. There is no backend, analytics, CDN or third-party script. A strict Content-Security-Policy blocks everything else. |
| Locking | The app auto-locks when you leave it (configurable). Content is hidden in the app switcher. Wrong passcodes trigger escalating delays. |
| Recovery | There is none. If you forget your passcode and lose Face ID, the data can't be decrypted. Use *Export chats* if you want a backup. |

## Deploy to GitHub Pages

1. Push these files to a GitHub repo.
2. In the repo, go to **Settings → Pages → Build and deployment** and set Source to **GitHub Actions**.
3. Every push to `main` or `ai-chat-app` runs `.github/workflows/pages.yml`, which publishes only the app files. After about a minute, the site is live at `https://<user>.github.io/<repo>/`. You can also re-run it from the **Actions** tab.

Any static HTTPS host works too (Cloudflare Pages, Netlify, …). HTTPS is required for encryption and Face ID.

## Install on iPhone

1. Open the URL in **Safari**.
2. Tap **Share → Add to Home Screen**.
3. Open it from the Home Screen, create a passcode, then add your API key in Settings.
4. In **Settings → Security → Enable Face ID**, confirm with Face ID.

> Always use the Home Screen app. Its storage is separate from Safari's, and iOS doesn't evict it the way it can evict website data.

## Notes

- `gpt-image-1` requires a *verified* OpenAI organization. If you get a verification error, use `dall-e-3` or verify your org.
- On Anthropic or OpenRouter, add an OpenAI key under *Image generation* to enable images.
- **DeepSeek**: choose provider *DeepSeek* with model `deepseek-flash` (cheap) or `deepseek-v4-pro`. *Thinking* sets the reasoning depth (Off / Low / High / Max). The reasoning shows in a collapsible block. DeepSeek stores data in China, so don't send it anything sensitive.
- Tap **Fetch** next to *Model* to list the models your key can use.
- Your passkey is created for the site's domain. If you move the app to a different URL, enable Face ID again there.

## Files

`index.html` · `style.css` · `app.js` (all logic) · `sw.js` (offline cache, never caches API calls) · `manifest.webmanifest` · `icons/`
