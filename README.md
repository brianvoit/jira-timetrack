# Jira Time Helper

A Firefox extension that starts the right **pm.plaudit.com** timer from a Jira ticket, with an AI-written note (Gemini or Claude) in the format:

```
Description of work done (TICKET-123)
```

Works on `/browse/` issue pages, `/projects/…/issues/…` views, and RapidBoard boards (with an issue selected).

### How the PM timer is chosen
1. **Existing entry** — if a PM entry's note already ends in `(TICKET-123)`, it is resumed.
2. **Listed on the ticket** — a PM project link (`viewProjects=<id>`) or exact project name in the ticket.
3. **Client match** — the Jira key / project name is matched to PM client and site names
   (e.g. `SMARTVEST` → `smartvest.com - Google Ads`), then the AI picks the best-fit timer
   for that client from the ticket's title and description.
4. **No client match** — the AI suggests a timer and you confirm it in a picker. The choice is remembered.

Every start says which timer it used and offers **Change timer**.

---

## Project Structure

```
jira-timetrack/
├── .github/
│   └── workflows/
│       └── release.yml       # Auto-signs and releases on version tag
├── extension/
│   ├── manifest.json
│   ├── background.js         # PM timer flow, toolbar badge
│   ├── content.js            # Jira: reads the issue (REST API), "Start timer" button
│   ├── gmail.js              # Gmail: reads the open thread, "Start timer", pause on send
│   ├── popup.html / popup.js # AI note, copy, Today panel, settings
│   ├── lib/
│   │   ├── jira.js           # URL → issue key (single source of truth)
│   │   ├── ai.js             # Gemini / Claude calls, note + project best-fit
│   │   ├── pm.js             # pm.plaudit.com client (Timers page, project tree)
│   │   └── widget.js         # the floating Start timer panel (Jira + Gmail)
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

1. Be signed in to **pm.plaudit.com** in Firefox.
2. First time: click the toolbar icon → **···** and add an AI key
   - **Gemini:** key at [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
   - **Claude:** key at [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
3. Open a Jira issue and click **▶ Start timer** (bottom-right of the page), or **▶ Start PM timer** in the popup
   (the popup lets you edit the note first).
4. The toolbar badge shows the running timer's elapsed time, or **!** if a timer has been running too long.
5. The popup's **Today** panel shows hours logged today (every timer, billable or not) against your daily goal (default 6.5 h, set in **···**)
   and flags runaway timers and entries without notes.
6. **Blank PM timers get filled in.** Start timers straight in PM without a note if you like: at the end of
   the day (default 4:30 pm, set in **···**) the extension writes a note on each of today's blank entries
   from the Jira tickets you touched for that client (and timer) that aren't logged yet —
   `Description (MARY-53)`, or `Description (MARY-60, MARY-61)` when one entry covers several. Existing notes are
   never changed; blank entries with no matching ticket are left and listed. **Fill N blank timers** in the
   popup's Today card does it on demand. **Jira tickets today** lists what you touched with its PM time.
7. **Gmail:** open a client email and click **▶ Start timer** (bottom-right). The client is matched from the
   email **addresses only** (domain → PM client/site names, choices remembered); the AI picks among that
   client's timers from the subject and latest message. The note is always
   `Correspondence with client about X, Y, and Z` (broad topics only). One PM entry per thread — coming
   back to the thread resumes it. Sending a reply pauses the thread's timer. Addresses are never sent to
   the AI; quoted history is dropped and emails/phones are redacted (turn off "Use the email's text" in
   **···** to send the subject only).
8. **End of day** (weekdays): fills blank timers, then one notification with what was filled, anything left
   blank, and today's hours vs your goal.
9. **Timers left running after hours get paused** (weekdays, default 5:00 pm, set in **···**). A timer that was already
   running before then is paused (PM's Pause button) once today's total reaches your daily goal, with a warning 5 minutes
   ahead. Click the warning to keep it running tonight. Timers you start after 5:00 are left alone. A timer still
   running from a past day is paused as soon as Firefox sees it, and the notification says how much to trim in PM.

---

## Development

To test locally without releasing:

1. Open Firefox → go to `about:debugging`
2. Click **This Firefox** → **Load Temporary Add-on…**
3. Select `extension/manifest.json`

Changes to files take effect after clicking **Reload** in `about:debugging`.
