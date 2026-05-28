# Jira Time Helper

A Firefox extension that scans a Jira issue page and uses AI (Gemini Flash or Claude Haiku) to generate a clean one-liner time entry in the format:

```
Description of work done (TICKET-123)
```

Works on standard `/browse/` issue pages and RapidBoard planning/sprint views.

---

## Project Structure

```
jira-timetrack/
├── .github/
│   └── workflows/
│       └── release.yml       # Auto-signs and releases on version tag
├── extension/
│   ├── manifest.json
│   ├── background.js
│   ├── popup.html
│   ├── popup.js
│   ├── content.js
│   └── icons/
│       ├── icon48.png
│       └── icon96.png
├── updates.json              # Auto-updated by CI — Firefox polls this for updates
└── README.md
```

---

## One-Time Setup

### 1. Add AMO API secrets to GitHub

Go to **GitHub → Settings → Secrets and variables → Actions** and add:

| Secret name       | Where to get it |
|-------------------|-----------------|
| `AMO_JWT_ISSUER`  | [addons.mozilla.org/developers/addon/api/key](https://addons.mozilla.org/en-US/developers/addon/api/key/) |
| `AMO_JWT_SECRET`  | Same page — shown once at generation time |

`GITHUB_TOKEN` is provided automatically by GitHub Actions — no setup needed.

---

## Releasing a New Version

Every release is triggered by pushing a **version tag**. The workflow will:
1. Sign the extension via Mozilla AMO
2. Create a GitHub Release with the signed `.xpi` attached
3. Automatically update `updates.json` so existing installs update silently

### Steps

**1. Update the version in `extension/manifest.json`**

**2. Commit and tag:**
```bash
git add .
git commit -m "chore: bump version to X.X"
git tag vX.X
git push origin main --tags
```

That's it. GitHub Actions handles the rest. Check the **Actions** tab to watch it run.

---

## First Install

After the first release completes:

1. Go to the GitHub Release page
2. Download `jira-time-helper.xpi`
3. Drag and drop it into Firefox → click **Add**

Future updates are delivered automatically — Firefox polls `updates.json` and installs new versions silently.

---

## Usage

1. Navigate to any Jira issue or RapidBoard (click an issue first on board views)
2. Click the extension icon in the toolbar (shows a green dot on Jira pages)
3. First time: click **···** and add your API key
   - **Gemini:** free key at [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
   - **Claude Haiku:** key at [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
4. Edit the AI result in the box if needed, then click **Copy Summary**
5. Paste into Harvest, Toggl, etc.

---

## Development

To test locally without releasing:

1. Open Firefox → go to `about:debugging`
2. Click **This Firefox** → **Load Temporary Add-on…**
3. Select `extension/manifest.json`

Changes to files take effect after clicking **Reload** in `about:debugging`.
