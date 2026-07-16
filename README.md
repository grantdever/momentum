# Honest Streaks

A personal daily habit tracker, installed as a home-screen web app on iPhone. It's a single-screen, offline-capable Progressive Web App — no accounts, no backend, no tracking. Your data lives in your browser's local storage, with an optional GitHub sync for backup and multi-device use.

## Install on iPhone

1. Open **https://grantdever.github.io/momentum/** in Safari.
2. Tap the Share icon, then **Add to Home Screen**.
3. Launch it from the home screen icon — it opens full-screen, no browser chrome.

## Optional GitHub sync setup

Sync is off by default. To enable it:

1. Create a small **private** GitHub repo to hold your data (e.g. `momentum-data`).
2. Create a fine-grained personal access token: GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens** → New token.
   - **Repository access**: limit it to just the data repo you created.
   - **Repository permissions**: set **Contents** to **Read and write**.
3. In the app, open **Settings** and enter:
   - Owner (your GitHub username)
   - Repo (the data repo name)
   - Path (e.g. `data.json`)
   - Token (the fine-grained PAT from step 2)
4. Enable sync.

The token is stored **only on this device**, in the browser's local storage. It is never sent anywhere except directly to GitHub's API.

## Daily reminder

Use the iOS **Shortcuts** app to nudge yourself each evening:

1. Shortcuts → **Automation** → **+** → **Create Personal Automation**.
2. Choose **Time of Day**, set it to 9:00 PM, daily.
3. Add action: **Open URL** → the app's URL.
4. Turn off "Ask Before Running" so it fires silently.

## Data safety

- The **Export JSON** button (in Settings) always works, regardless of sync status — use it to back up your data by hand at any time. This matters because iOS can evict web storage under low-disk conditions.
- If GitHub sync is enabled, every save is a commit to your data repo, so you get a free edit history.

## Local development

Because this app uses ES modules, it won't run directly from a `file://` URL. Serve it locally instead:

```
python3 -m http.server 8741
```

Then open `http://localhost:8741/` in a browser.

## Notes

- After deploying an update, iOS applies the new service worker on the *next* launch — the first open after a deploy may still show the previous cached version.
