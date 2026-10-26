# Local Business Finder

A mobile-friendly Next.js + TypeScript app that finds local businesses from **OpenStreetMap** data (via the **Overpass API**), lets you check their website status manually, save them as leads, open a pre-filled **WhatsApp** message (you press send), and export your leads as CSV.

No Google API. No Google Cloud billing. No credit or debit card needed for the MVP.

---

## 1. What works and what was tested

Built-in features:

- Search restaurants, cafes, hotels, salons, gyms, coaching/training, shops, medical, and other services
- Preset locations: Fazilnagar, Kasia, Padrauna, Kushinagar, plus **custom coordinates** and "Use my current location"
- Per business: name, category, address, phone, website, OpenStreetMap link, Google Maps **search link**, WhatsApp button (only when a valid mobile number exists), Call button
- Website labels: **Website Listed**, **No Website Listed**, **Unknown** (see section 3)
- Manual verification, lead saving, statuses (New, Verified, Contacted, Interested, Not Interested, Client), notes
- CSV export of your own saved leads
- OpenStreetMap attribution on every screen that shows map data
- Optional cloud backup of leads with Supabase

Testing done before delivery:

- Whole project type-checked (strict TypeScript).
- Core logic unit-tested: phone/WhatsApp number rules, website cleaning, Overpass query building, result parsing, website labels, CSV escaping and formula-injection protection, message template, rate limiter.

**Not tested before delivery** (the build environment had no internet): `npm install`, `next build`, a real Overpass request, Supabase, and a real phone screen. The layout is written mobile-first (large tap targets, bottom tab bar, single-column cards), but please check it on your phone after deploying. If the Vercel build fails, copy the error text and send it to me.

## 2. Costs

| Part | Cost |
| --- | --- |
| OpenStreetMap data, Overpass public server | Free, no key, no card |
| WhatsApp Click-to-Chat links (`wa.me`) | Free. Messages are sent from your own WhatsApp |
| GitHub, Supabase free tier | Free, no card normally required |
| Vercel Hobby plan | Free, no card, **but see the warning below** |

**Important: Vercel Hobby is for non-commercial personal use only** (Vercel's Terms and Fair Use Guidelines). If you use this tool to find clients for your paid freelance work, that may count as commercial use. Options: use it only for personal/learning purposes on Hobby, move to Vercel Pro (paid, needs a card), or host the project somewhere whose free plan allows commercial use (check their terms first). Read https://vercel.com/docs/limits/fair-use-guidelines before deciding.

Optional things that could cost money later: Vercel Pro, a custom domain, Supabase paid plans, or hosting your own Overpass server. None are needed.

## 3. Understanding the data (please read)

- OpenStreetMap is volunteer-edited. Small-town coverage is patchy. **"Nothing found" does not mean no businesses exist.**
- Only places that have a **name** on the map are shown.
- **"No Website Listed" means only that the map record has no website field.** It does not mean the business has no website. The app says this under each badge. Always verify before telling a business "you have no website."
- **"Unknown"** is used when the map's website value cannot be read, or when you mark "Not sure".
- **"Verify website manually"** gives you two links (Google Maps search and Google search) that you open yourself, then you record what you found. Your answer overrides the automatic label.
- Phone numbers are shown only if listed on the map. The WhatsApp button appears only for numbers that look like mobile numbers (Indian rules: 10 digits starting 6-9, or +91 form; landlines are skipped). A number can look valid and still not have WhatsApp.
- Preset town coordinates are approximate centres. Use custom coordinates for an exact centre.

## 4. Overpass usage policy and built-in limits

The app uses the free public Overpass server (`https://overpass-api.de/api/interpreter` by default). Its operators ask users to keep usage modest (their documentation describes roughly under 10,000 queries and 1 GB of data per day for the whole server, and the server may answer 429 or 504 when busy). Check the current policy: https://wiki.openstreetmap.org/wiki/Overpass_API

Built-in safeguards:

- One small query per search: one place, one category, radius 300 m to 5 km, at most 100 results, 20 second query timeout
- Searches go through your own server route, never directly from the browser
- 5-second cool-down after each search in the app
- Server limit of 6 live searches per minute per visitor and 30 per minute overall (best effort on Vercel)
- Results cached for 15 minutes per place/type/radius, so repeat searches do not hit Overpass
- Clear loading indicator and plain-language error messages for busy, timeout, and rate-limit situations
- A User-Agent that names the app and your contact (set `OVERPASS_CONTACT`)
- No scraping of Google Maps, no bulk downloads, no automatic repeated searches

The app does **not** use the public Nominatim service. Locations come from the preset list or coordinates you type.

If Overpass is down or busy, wait a few minutes. You may set `OVERPASS_URL` to another Overpass server if you have permission to use it.

## 5. Deploy from an Android phone (free)

You will use: Chrome, the Termux app, GitHub, and Vercel.

### Step A: Put the project on GitHub

1. Install **Termux** from **F-Droid** (the Play Store version is outdated): https://f-droid.org/packages/com.termux/
2. Create a free GitHub account at https://github.com/signup if you do not have one.
3. In Chrome open https://github.com/new, name the repository `local-business-finder`, choose **Private**, leave everything else empty, tap **Create repository**.
4. Create a token: GitHub > profile photo > **Settings** > **Developer settings** > **Personal access tokens** > **Tokens (classic)** > **Generate new token (classic)**. Tick **repo**, generate, and copy the token somewhere safe. You will use it as your password in Termux.
5. Save `local-business-finder.zip` to your phone's Downloads folder.
6. Open Termux and run these one at a time:

```bash
pkg update -y
pkg install -y git unzip
termux-setup-storage
```

Allow the storage permission when asked. Then:

```bash
cd ~
unzip ~/storage/downloads/local-business-finder.zip
cd local-business-finder
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_GITHUB_USERNAME/local-business-finder.git
git push -u origin main
```

When asked for **Username**, type your GitHub username. When asked for **Password**, paste the token (nothing shows while pasting; press Enter).

### Step B: Deploy on Vercel

1. Open https://vercel.com/signup and choose **Continue with GitHub**. Pick the **Hobby** plan (read the warning in section 2).
2. Tap **Add New...** > **Project**, find `local-business-finder`, tap **Import**.
3. Framework should show **Next.js**. Leave build settings as they are.
4. Optional: open **Environment Variables** and add `OVERPASS_CONTACT` = your email. (Everything else can wait.)
5. Tap **Deploy**. After a minute or two you get a link like `https://local-business-finder-xxxx.vercel.app`.
6. Open it, choose Fazilnagar and Restaurants, and tap **Search businesses**.
7. In Chrome tap the three-dot menu > **Add to Home screen** to keep it like an app.

To update later: change files in Termux, then `git add . && git commit -m "update" && git push`. Vercel redeploys automatically.

If Termux/GitHub feels hard, an alternative is the Vercel CLI in Termux (`pkg install nodejs`, `npm i -g vercel`, `vercel login`, `vercel --prod`). It skips GitHub but is less tested on phones.

## 6. Optional: cloud backup with Supabase (free)

Skip this if saving leads on one phone is enough. Without it, leads live in your browser's storage (clearing browser data or switching phones loses them, so use CSV export as a backup).

1. Go to https://supabase.com, sign up, tap **New project** (free plan). Wait until it is ready. Free projects may pause after a period of inactivity.
2. Open **SQL Editor** > **New query**, paste the contents of `supabase/schema.sql`, tap **Run**.
3. Open **Project Settings** > **API**. Copy the **Project URL** and the **service_role** key. The service_role key is a secret: never share it or put it in the app code.
4. In Vercel open your project > **Settings** > **Environment Variables** and add:
   - `SUPABASE_URL` = the Project URL
   - `SUPABASE_SERVICE_ROLE_KEY` = the service_role key
   - `ADMIN_PASSCODE` = a long passcode you invent
5. In Vercel go to **Deployments**, open the latest one, tap the menu > **Redeploy**.
6. In the app open **Settings**, enter the passcode under Cloud backup, tap **Connect**. Leads on your phone are uploaded and future changes sync automatically.

How it stays private: the table is locked, and only your server (using the secret key) can read or write it, and only when the correct passcode is sent. The passcode is stored in your browser on your phone.

## 7. Environment variables

See `.env.example`. All are optional.

| Name | Purpose |
| --- | --- |
| `OVERPASS_URL` | Use a different Overpass server |
| `OVERPASS_CONTACT` | Your email, sent in the User-Agent |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_PASSCODE` | Optional cloud lead storage |

## 8. Responsible use

- WhatsApp: the app only opens a draft. You review and send each message yourself. Do not bulk-message people; unwanted messages can get your number blocked. Be respectful and relevant.
- Business data from OpenStreetMap is licensed under ODbL. Keep the attribution ("© OpenStreetMap contributors") if you share data derived from it. CSV exports include a data-source column.
- Phone numbers are personal data in some cases. Keep your lead list private and delete leads who ask you to stop.
- Follow India's rules on commercial messaging and your local laws.

## 9. Run on a computer (optional)

```bash
npm install
npm run dev
```

Open http://localhost:3000. Copy `.env.example` to `.env.local` to set variables.

## 10. Project structure

```
app/            page, layout, styles, and two API routes (/api/search, /api/leads)
components/     SearchPanel, BusinessCard, LeadsPanel, SettingsPanel, small helpers
hooks/          useLeads (browser storage + optional cloud), useSettings
lib/            Overpass query/parsing, categories, locations, phone/website rules, CSV
supabase/       schema.sql for optional cloud storage
```

## 11. Troubleshooting

| Problem | What to do |
| --- | --- |
| "Too many searches" | Wait the number of seconds shown |
| "The public map server is busy" | Wait a few minutes, use a smaller radius |
| Zero results | OSM coverage may be thin. Try a bigger radius or the Shops category |
| WhatsApp button missing | The map has no mobile number for that business |
| Cloud: "Wrong passcode" | Re-enter `ADMIN_PASSCODE` exactly as set in Vercel (redeploy after changing it) |
| Cloud: "not set up" | Add the three variables in Vercel and redeploy |
| Build error on Vercel | Copy the red error text from the Vercel deployment log and ask for a fix |
