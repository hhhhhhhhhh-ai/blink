# Blink — disappearing-snap chat app (web, phone-first)

Add friends by **username**, chat, and send **photos or videos that can be opened only once** — full-screen, with a timer bar and caption, like a snap. Installable on your phone's home screen.

The app is plain HTML/CSS/JS (no build step), so it can be hosted **free on GitHub Pages**. Sharing messages between phones needs a small free backend: **Supabase** (accounts, database, file storage, realtime).

| Mode | When | What you get |
|---|---|---|
| **Demo** | `js/config.js` left empty | Works instantly, data stays in your browser. 3 bot friends (mia, leo, zoe) reply to you. |
| **Real** | Supabase URL + key filled in | Real accounts. Chat with real friends on their own phones. |

---

## 1 · Set up the backend (Supabase, free, ~5 min)

1. Create a free account at <https://supabase.com> → **New project** (pick any name/password/region).
2. Open **SQL Editor → New query**, paste the whole contents of `schema.sql`, press **Run**. (Run it once; you should see “Success”.)
3. Go to **Authentication → Sign In / Providers → Email** and **turn OFF “Confirm email”**. (Otherwise sign-up waits for an email that Supabase’s free mailer rarely delivers.)
4. Go to **Project Settings → API** and copy the **Project URL** and the **anon public** key.
5. Open `js/config.js` and paste them in:
   ```js
   export const CONFIG = {
     SUPABASE_URL: 'https://xxxxxxxx.supabase.co',
     SUPABASE_ANON_KEY: 'eyJhbGciOi…',
   };
   ```
   The anon key is *meant* to be public — the security rules in `schema.sql` protect the data. **Never** paste the `service_role` key anywhere.

## 2 · Put it online with GitHub Pages (free)

1. Create a GitHub account → **New repository** → name it e.g. `blink` → set it to **Public** → Create.
2. Click **uploading an existing file**, then drag in **everything inside this folder** (`index.html`, `css/`, `js/`, `icons/`, `manifest.webmanifest`, `sw.js` …). Commit.
3. Repo **Settings → Pages → Build and deployment**: Source = **Deploy from a branch**, Branch = **main** / **(root)** → Save.
4. After ~1 minute your app is live at `https://YOUR-USERNAME.github.io/blink/`.

(Prefer something else? Any static host works: Cloudflare Pages, Netlify drag-and-drop, Vercel. Just upload the folder.)

## 3 · Install it on your phone

Open the link on your phone → **iPhone:** Share → *Add to Home Screen* · **Android:** ⋮ → *Install app* / *Add to Home screen*. It opens full-screen like a native app.

Send your friends the link; they sign up, then add each other by username.

---

## How it works

- **Camera tab** – tap the shutter for a photo, hold it for a video (max 15 s), flip camera, or pick from the gallery. Add a caption and a viewing time (3/5/10 s for photos), choose friends, send.
- **Snaps** show as a coloured tile (pink = photo, purple = video). Tap to open full-screen; it closes on its own, and then it is **gone** — the file is deleted from storage and the server refuses a second download. Senders see *Delivered → Opened*.
- **Chats** – regular text messages stay in the conversation. Unread badges, read receipts, live updates.
- **Friends** – add by username → the other person accepts. Only accepted friends can message each other.

### Files
```
index.html            app shell
css/style.css         all styling (dark, mobile-first, safe-area aware)
js/main.js            UI: auth, chats, friends, viewer, preview, send flow
js/camera.js          live camera + photo/video capture
js/backend.js         Supabase backend + built-in demo backend
js/config.js          ← put your Supabase URL + key here
schema.sql            database tables + security rules (run once in Supabase)
sw.js, manifest…      installable-app (PWA) bits
```

## Honest limits

- A web app **cannot block screenshots or screen recording** — nobody can, on the web. “View once” stops re-opening in the app, not copying.
- No push notifications when the app is closed (that needs a push server). New snaps/messages appear live while the app is open.
- Free Supabase tier: 1 GB file storage, 50 MB per file, and a project **pauses after ~1 week without activity** (one click to resume in the dashboard).
- Snaps are uploaded once per recipient so each person’s copy can be deleted independently; if someone never opens a snap, the file stays until it’s opened.
- iPhone `.mov` videos picked from the gallery may not play on some Android phones; videos recorded in the app are fine.
- Browsers only allow the camera on **https** (GitHub Pages is) or `localhost`.

## Try it locally
```bash
cd blink
python3 -m http.server 8000     # then open http://localhost:8000
```
(Opening `index.html` by double-click won’t work — browsers block ES modules from `file://`.)

## Troubleshooting
- **“Account created, but Supabase wants an email confirmation”** → step 1.3: turn off *Confirm email*, then log in.
- **“Email address … is invalid”** → use a real email address.
- **Can’t send to a friend** → you must both have accepted the friend request.
- **Page shows old version after you update files** → close the app fully and reopen (the service worker refreshes on next load).
