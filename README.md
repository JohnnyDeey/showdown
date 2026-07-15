# 🎯 Family Showdown — PWA

Real-time multiplayer number-guessing game. Players take turns narrowing down a hidden number. Timeout enforcement, solo-continue mode, live feed.

---

## Project Structure

```
showdown/
├── index.html          ← Single-file frontend (PWA shell)
├── manifest.json       ← PWA manifest
├── sw.js               ← Service worker (offline shell + update toast)
├── favicon.ico
├── icons/              ← App icons (72 → 512px)
├── firebase.json       ← Firebase Hosting + Functions config
├── .firebaserc         ← Project alias (set your project ID here)
├── firestore.rules     ← Security rules
├── firestore.indexes.json
└── functions/
    ├── index.js        ← Cloud Functions
    └── package.json
```

---

## Setup

### 1. Firebase Project
1. Create a project at https://console.firebase.google.com
2. Enable **Firestore** (Native mode)
3. Enable **Cloud Functions** (requires Blaze plan)
4. Register a **Web App** and copy the config

### 2. Configure `index.html`
Replace the placeholder block near the bottom:
```js
const firebaseConfig = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT_ID.firebaseapp.com",
  projectId:         "YOUR_PROJECT_ID",
  storageBucket:     "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId:             "YOUR_APP_ID"
};
```

### 3. Configure `.firebaserc`
```json
{ "projects": { "default": "your-real-project-id" } }
```

---

## Deploy via Google Cloud Shell

```bash
# 1. Clone your repo
git clone https://github.com/YOUR_USERNAME/showdown.git
cd showdown

# 2. Install Firebase CLI (if not already)
npm install -g firebase-tools

# 3. Log in
firebase login --no-localhost

# 4. Install function dependencies
cd functions && npm install && cd ..

# 5. Deploy everything
firebase deploy
```

### Deploy only hosting (frontend updates):
```bash
firebase deploy --only hosting
```

### Deploy only functions:
```bash
firebase deploy --only functions
```

---

## Deploy via GitHub Pages (frontend only)

> Note: GitHub Pages can't run Cloud Functions. Use Firebase Hosting for the full app.
> For GitHub Pages, host only the frontend and point Firebase Functions to the same Firestore.

1. Push to GitHub
2. Go to **Settings → Pages**
3. Set source to `main` branch, root `/`
4. Your app is live at `https://USERNAME.github.io/REPO/`

---

## Deploy via Vercel (frontend only)

1. Import repo at https://vercel.com/new
2. Framework: **Other**
3. Build command: *(leave blank)*
4. Output directory: `.` (root)
5. Deploy ✓

---

## How the Game Works

| Step | What happens |
|------|-------------|
| Host creates room | A secret number is picked, a 6-letter code is generated |
| Players join | Enter code + name + 4-digit PIN |
| Host starts game | Player order is shuffled, timer begins |
| Each turn | Active player guesses; range narrows (too high / too low) |
| 60s timeout | Timed-out player is removed; game continues or prompts solo |
| Solo decide | Last player can continue solo or close the room |
| Win | First player to guess the exact number (±0.005) wins |

---

## Bumping the Service Worker (on each deploy)

In `sw.js`, increment the cache version:
```js
const CACHE_VERSION = 'showdown-v2'; // ← bump this
```
This forces existing installs to update and shows the update toast.

---

## Cloud Functions Summary

| Function | Trigger | Purpose |
|----------|---------|---------|
| `createGameRoom` | onCall | Create room + pick secret number |
| `startGame` | onCall | Shuffle players, move to 'playing' |
| `submitGuess` | onCall | Validate guess, narrow range, rotate turn |
| `handleTimeout` | onCall | Remove AFK player, handle solo/close |
