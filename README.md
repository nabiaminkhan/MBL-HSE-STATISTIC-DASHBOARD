# MBL HSE Dashboard — Setup, Deploy & Update Guide

**MBL-ASP · Modern Building Leaders · HSE**

This package is a complete, ready-to-deploy website. Everything the dashboard
needs is inside this folder — you only have to upload it to Vercel once and set
four settings.

---

## 1. What is in this folder

| File / folder | What it is |
|---|---|
| `index.html` | The whole dashboard (all pages, charts, reports) |
| `api/login.js` | Checks the admin password on the server |
| `api/publish.js` | Saves the admin's data so everyone can see it |
| `api/data.js` | Gives every visitor the latest published data |
| `api/_lib/security.js` | Shared password / session / origin checks |
| `sw.js` | Offline support (works with no signal) |
| `manifest.json`, `icons/` | "Add to Home Screen" app name and icons |
| `logo.png` | MBL logo used on screen and in reports |
| `vercel.json`, `package.json` | Hosting configuration |

---

## 2. The four settings (Environment Variables)

In Vercel open your project → **Settings → Environment Variables**. Add these
for **Production, Preview and Development**:

| Name | Value | Required? |
|---|---|---|
| `ADMIN_PASSWORD` | `MBL@HSE2026` (or any password you prefer) — no quotes, no spaces | **Yes** |
| `AUTH_TOKEN_SECRET` | Any long random text, e.g. 40 mixed characters | Recommended |
| `BLOB_READ_WRITE_TOKEN` | Created automatically when you connect Vercel Blob storage | **Yes** |
| `ALLOWED_ORIGINS` | Only if another website must call this one, e.g. `https://hse.mbl-asp.com` | Optional |

Notes:

- The password is **never** written inside `index.html`. It lives only on the
  server, so nobody can read it from the browser.
- If you change `ADMIN_PASSWORD` or `AUTH_TOKEN_SECRET`, everyone currently
  unlocked as admin is signed out and must unlock again. That is normal.
- `ALLOWED_ORIGINS` accepts several addresses separated by commas. Your own
  Vercel address and custom domain are trusted automatically — you do not need
  to list them.

---

## 3. First-time deployment

1. Create a new GitHub repository and upload **the contents of this folder** to
   the repository root (so `index.html` is at the top level, not inside a
   sub-folder).
2. In Vercel click **Add New → Project**, import that repository, and choose
   Framework Preset **Other**. Leave build and output settings empty.
3. Before or right after the first deploy, open **Storage → Create → Blob** and
   connect the Blob store to this project. Vercel then adds
   `BLOB_READ_WRITE_TOKEN` for you.
4. Add `ADMIN_PASSWORD` and `AUTH_TOKEN_SECRET` as described above.
5. Click **Deployments → Redeploy** so the new settings take effect.
6. Open the site, click the lock / admin button, enter the password, upload your
   Excel files, then press **Save & Publish**. Wait for the success message.
7. Open the site in a different browser or on a phone (without logging in) and
   confirm the same numbers appear. That proves publishing works.

---

## 4. Updating an existing deployment

1. Replace the old files in your repository with the files from this folder and
   commit. Vercel redeploys automatically.
2. Confirm the four settings above still exist.
3. Open the site as admin, upload the latest Excel files and press
   **Save & Publish** once. Viewers get the new data within about three minutes,
   or instantly if they reload.
4. If the page still looks old, do one hard refresh (or close and reopen the
   installed app). The offline cache has been renamed in this build, so the old
   cached copy is deleted automatically the first time the new version loads.

---

## 5. Everyday use

- **Admin can:** upload Excel data, Save & Publish, add incident and good
  practice photos, edit HSE / Medical team details, clear the audit trail.
- **Viewers can:** browse every page, filter, and export PDF / PowerPoint
  reports. They cannot change any data.
- Publishing large data with photos is sent in several pieces automatically; the
  toast messages show "part 1 of 3" etc. Let it finish before closing the tab.

---

## 6. Issues fixed in this build

**Publishing (the main problem)**
- Publishing failed once real Excel data and photos were added, because the
  hosting platform rejects requests above roughly 4.5 MB. The dashboard now
  compresses the snapshot and uploads it in ordered pieces, so viewers finally
  receive the admin's data.
- Every visitor now loads the published data on page open and refreshes it every
  three minutes, instead of only reading their own browser storage.
- Clear, honest error messages when storage or the password is not configured,
  instead of a silent failure.

**Security**
- The admin password was hard-coded in the page source; it is now an
  environment variable checked on the server, with a constant-time comparison
  and a short delay after a wrong attempt.
- Admin sessions use a signed, expiring token (8 hours) instead of resending the
  password with every request.
- The APIs no longer accept requests from any website (`*`); only your own
  address and anything you allow-list are permitted.
- All values coming from Excel files or user input are escaped before being
  shown, so a stray `<` or a formula in a spreadsheet cell can no longer inject
  code into the page.

**Data quality**
- Blank rows and exact duplicate rows from Excel are removed on import, so
  counts and charts are no longer inflated.
- Dates are read reliably from Excel serial numbers and from day/month/year and
  month/day/year text formats, so trends land in the right month.

**Reliability**
- Browser storage is wrapped safely: on private / restricted browsers where
  storage is blocked, the dashboard keeps working in memory instead of crashing
  on a white screen, and a full-storage error is reported clearly.
- The offline cache no longer stores API responses, so nobody sees stale
  published data; the cache version was bumped and old versions are purged.
- Duplicate helper functions were removed so only one definition is in effect.

**Installability & accessibility**
- Proper app icons (192, 512, maskable and Apple touch) plus a corrected app
  manifest, so "Add to Home Screen" shows the MBL icon and name.
- Tables announce their sort state, dialogs and buttons carry accessible labels,
  and the old blocking browser pop-up prompts were replaced with proper in-page
  dialogs.

---

## 7. "Incorrect password" — how to fix it

The password is checked on the server, so this message almost always means the
server does not have the password you think it has. Work through this list in
order.

**Step 1 — run the built-in self-check.** Open your site, add `/api/login` to
the end of the address and press enter. You will see a short report:

- `"configured": true` — the server has a password. Go to step 3.
- `"configured": false` — the server has **no** password. Go to step 2.
- A page that says "not found" or shows HTML instead of that report — the `api`
  folder was not deployed. Make sure the `api` folder sits next to
  `index.html` in your repository root, commit, and redeploy.

The report also flags common mistakes: `hadSurroundingQuotes`,
`hadSurroundingWhitespace` or `hadInvisibleCharacters` set to `true` means the
saved value has extra characters around it. This build now cleans those up
automatically, but it is still worth re-saving the value cleanly.

**Step 2 — add the password properly.** In Vercel: **Settings → Environment
Variables → Add New**.

- Name: `ADMIN_PASSWORD` (exactly this, all capitals, underscore in the middle)
- Value: `MBL@HSE2026` — typed with no quotes, no spaces before or after
- Environments: tick **Production, Preview and Development** (a very common
  mistake is ticking only Preview, so the live site has nothing)

**Step 3 — redeploy.** Environment variables only reach the site on a new
deployment. Go to **Deployments**, open the newest one, and choose **Redeploy**.
Saving the variable alone changes nothing on the running site. After redeploying,
re-run the self-check from step 1 and confirm `"configured": true`.

**Step 4 — check what you are typing.** The password is case-sensitive and
symbols matter: `MBL@HSE2026` has capital M-B-L, the `@` sign, capital H-S-E and
the year 2026. Common slips are a lowercase letter, the digit `0` instead of the
letter `O`, a phone keyboard adding a space, or an Arabic-layout keyboard
producing a different `@`. Type it by hand once rather than pasting. Leading and
trailing spaces are now ignored automatically.

**Step 5 — make sure you are on the deployed site.** Opening `index.html`
directly from your computer, or from a file-sharing preview, means there is no
server to check the password and login can never succeed. The address must be
your `https://…vercel.app` (or custom domain) address.

If you changed the password recently, note that anyone already unlocked stays
unlocked for up to 8 hours, and the new password only works after a redeploy.

---

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| "Incorrect password" | Work through section 7 above — usually the setting is missing or the site was not redeployed |
| "The login service is not responding correctly" | The server side crashed. Check that `package.json` is present in the repository root and still contains the line `"type": "module"` (see section 9), then redeploy |
| Login still fails right after a redeploy | Your browser is showing the saved older copy of the page. Hard-refresh (Ctrl+F5, or Cmd+Shift+R on Mac), or see section 9 |
| "Admin login is not set up on the server yet" | `ADMIN_PASSWORD` is missing — add it and redeploy |
| "Login service not found" | The `api` folder was not uploaded to the repository root |
| "This address is not allowed to sign in" | Add that address to `ALLOWED_ORIGINS` and redeploy |
| "Sharing is not switched on yet" / "storage not connected" when you press **Save & Publish** | Shared storage was never connected. Follow section 10 — it takes about a minute |
| "Session expired" while publishing | Unlock admin again; sessions last 8 hours |
| "No published data yet" for viewers | Admin must press **Save & Publish** once |
| Viewers see old numbers | Publish again, then hard-refresh; check the deploy finished |
| Publish fails on a very large upload | Retry; if it repeats, add fewer photos at a time |

---

## 9. Two things that must stay as they are

**Keep `package.json` exactly as shipped.** That small file tells the hosting
platform how to read the four server files in the `api` folder. If it is deleted,
or if the line `"type": "module"` is removed, every server request fails and the
site reports *"The login service is not responding correctly"* — even when the
password is perfectly correct. Always upload `package.json` together with
`index.html` and the `api` folder.

**After each update, refresh properly.** The site keeps an offline copy of itself
so it still opens without internet. That copy can hide a fresh deployment for a
while. After redeploying:

1. Press Ctrl+F5 (Windows) or Cmd+Shift+R (Mac) on the site, or
2. Open the site in a private/incognito window to confirm the new version, or
3. For a full reset: browser menu → developer tools → Application → Service
   Workers → **Unregister**, then reload.

Visitors do not need to do anything special; their copy updates by itself within
a minute or two of opening the site.

---

## 10. Switching on sharing (one-time, about one minute)

**The message:** you press **Save & Publish** and a red bar says sharing is not
switched on / storage is not connected.

**What it means:** nothing is broken and nothing was lost. Your edits are safely
kept in your own browser. What is missing is the shared filing cabinet — the
place on the internet where the dashboard keeps one copy of the data that
everyone else reads. Until that cabinet exists, the site has nowhere to put the
published version, so it politely refuses instead of pretending it worked.

**How to switch it on:**

1. Sign in to Vercel and open your project.
2. Click the **Storage** tab at the top.
3. Click **Create** (or **Create Database**) and choose **Blob**.
4. Give it any name, e.g. `mbl-hse-data`, and confirm.
5. When asked which project to connect it to, choose this project and connect it.
   Vercel now creates the `BLOB_READ_WRITE_TOKEN` setting for you — you never
   type it yourself, and you should not edit or delete it.
6. Go to the **Deployments** tab, open the newest deployment, and choose
   **Redeploy**. This is what lets the site see the new setting.
7. Wait for "Ready", open the site, hard-refresh (Ctrl+F5 / Cmd+Shift+R),
   unlock admin, and press **Save & Publish** again.

You should now see the green *"Published live!"* message. From then on, everyone
opening the site sees your published numbers, photos and theme, and you only
repeat step 7's publish — never steps 1 to 6.

**Good to know:** the free storage allowance is far more than this dashboard
needs, and connecting it does not change anything else about the site. If you
choose never to connect it, the dashboard still works perfectly as a personal
offline tool — the data simply stays on the device where you entered it.


---

## 11. HSE Overtime page (new)

- Sidebar item **HSE OVERTIME**.
- Week runs **Saturday → Friday**. Each Saturday starts a new week automatically.
- **Viewers and admin** can add rows: Name, Iqama, Area (optional Hours).
- Data is stored on the device and included when admin presses **Save & Publish**, so all users see the same overtime list after publish.
- Entries can be removed from the list (trash icon).

## 12. Storage limits (honest)

- **Vercel request body limit (~4.5 MB)** is handled by gzip + chunked publish. You cannot raise that platform limit from this project.
- **Vercel Blob free tier** is about **1 GB storage** (not 10 GB). Paid Blob plans offer more. Connecting Blob once is enough; size is managed by hosting plan, not by a number inside this app.
- Browser **localStorage** is typically 5–10 MB. Large photo sets use IndexedDB where possible. If the browser reports storage full, remove old photos or publish less image data at once.

## 13. Login still failing?

Almost always environment variables or cache — follow section 7 in order (self-check → ADMIN_PASSWORD → redeploy → hard refresh). The password is never inside `index.html`.
