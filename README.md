# My Finances: phone-only version

The finance tracker running entirely on your iPhone. No laptop, no server, no account.
The laptop version in `finance-app/` is unchanged and separate; they don't share data.

## What it does
- Reads Al Rajhi alert texts (same parser as the laptop version: PoS, online purchase, Visa card payoff as a transfer, salary, transfers, ATM, bills, refunds; OTPs and offers ignored).
- Categories tuned for Saudi spending (groceries, dining, coffee, fuel, rides, car, health, personal care, home, shopping, bills, government, and more; hundreds of local merchant names in English and Arabic). Change any transaction and tick "Always use this category" to teach it a merchant. Subscription detection (price changes, cancelled, "not a subscription"), refunds net off spending, Riyadh dates, Salary tab with GOSI helper.
- Blue/white dashboard in SAR.

## Privacy and security
- **Encrypted on the phone.** All data is one record in IndexedDB, encrypted with AES-256-GCM. The key comes from your password (PBKDF2-SHA256, 600,000 rounds) and is never stored. Lose the password and the data can't be opened, so keep backups.
- **No network.** The page's Content-Security-Policy has `connect-src 'none'`: its code can't send data anywhere. The website it's loaded from only ever delivers the app's files.
- **Auto-lock** after 1/5/15 minutes idle, and whenever you leave the app for over a minute. 5 wrong passwords → waiting time that doubles, kept across reloads. Passwords must be 12+ characters (a short phrase is best), because a backup file could be guessed at offline by anyone who gets hold of it.
- **Backups** are the same encrypted record saved as a `.json` file (Settings → Back up → Save to Files / iCloud Drive). Restoring needs the password the backup was made with.
- **Delete all my data** (Settings) removes the database from the phone.
- Texts are added through the clipboard, not the URL, so they never end up in Safari's history. The app clears the clipboard after adding them.

## Trust in the host
Whoever controls the website the app is loaded from controls its code, and a changed version could in theory read data after you unlock it. It's hosted on GitHub Pages from your own account (MAbudabeel/my-finances), so only you (and GitHub) can change it. Keep 2-factor login on your GitHub account.

## Getting it onto the iPhone
It's a set of static files that must be opened once from an HTTPS address. After that it works offline. Hosting options (see the thread for the trade-offs): GitHub Pages from your own account, Cloudflare Pages / Netlify, or the laptop over home Wi-Fi.

Then in Safari: open the address → Share → **Add to Home Screen**. Use the Home Screen icon from then on: iOS keeps a Home Screen app's data, but Safari can clear a website's data if it isn't opened for a few weeks. Note that the Home Screen app and a Safari tab have **separate** storage on iOS: pick one (Home Screen) and stick with it.

## Getting Al Rajhi texts in (iOS Shortcuts)
**0. Folder.** Files → Browse → On My iPhone → ⋯ → New Folder → `Finances` (keeps queued texts off iCloud).

**1. Collect texts automatically (one-time setup, iOS 17+).** Shortcuts → Automation → **+** → **Message** → leave Sender empty (Al Rajhi's name-style sender can't be saved as a contact) → **Message Contains**: `بـ` (the letter ب with the stretch mark, copy it from here; it's in front of the amount in every Al Rajhi alert) → **Run Immediately**, Notify When Run off → Next → New Blank Automation, then add:
1. **Text**: `##SMS##`, return, then the **Shortcut Input** variable (set to **Content**).
2. **Append to Text File**: append the Text to `bank-texts.txt` in **On My iPhone › Finances**, **Make New Line** on.

**1b. Second automation** for texts without بـ (transfers between your accounts write "مبلغ:SR", loan installments "القسط:"): repeat step 1 with **Message Contains** `مبلغ`. Add a **third** the same way with `سحب` for ATM withdrawals (they write the amount as "بSR", without the stretch mark). A text caught by more than one automation is saved more than once in the file but added to the app only once.

The alert's own date and time are used, so no timestamp is needed. Other texts that happen to contain `بـ` are saved too, but the app ignores anything that isn't a purchase/transfer/salary-style alert with an amount. If another bank's alert ever slips in, open it in the app and tap Delete.

**2. "Bank texts" shortcut (run when you want to update).** Shortcuts → **+** → name it *Bank texts*:
1. **Get File** `bank-texts.txt` from On My iPhone › Finances (Show Document Picker off, Error If Not Found off).
2. **Copy to Clipboard**.
3. **Text** containing just `-`, then **Save File** that Text to the same `bank-texts.txt` (Ask Where to Save off, Overwrite If File Exists on). This empties the queue; the app ignores the `-`.
4. Optional: **Show Notification** "Bank texts copied, open Finances."

Add it to the Home Screen next to the app.

**Automatic option (recommended).** At the end of the automation, add **Get File** (`bank-texts.txt`, same folder, Error If Not Found off) and **Copy to Clipboard**. Then you don't need the "Bank texts" shortcut: when you unlock Finances it reads the clipboard during the Unlock tap (iOS asks you to tap **Paste**) and adds anything new. Trade-off: each Al Rajhi text replaces whatever you had copied, and the clipboard holds your bank texts until the next unlock. Turn it off in Settings → Security.

What iOS doesn't allow: a website app can't run in the background, read your files, or read the clipboard without a tap. So the one tap on Paste at unlock is the minimum.

**3. In the app:** open Finances → unlock → **Paste texts** → tap **Paste** when iOS asks.
Texts already added are skipped, so pasting the same batch twice is safe.

**Without Shortcuts:** in Messages, press and hold an Al Rajhi text → Copy → in the app tap **Paste texts** (or **Type…** and paste several).

## Files
```
index.html            screens (setup, lock, overview, salary, settings)
styles.css            laptop styles + phone additions
js/core.js            parser, categories, subscriptions, totals, salary (ported from finance-app/)
js/store.js           encrypted IndexedDB storage, backup/restore, wipe
js/demo.js            6 months of fake alerts for "Try it with demo data"
js/app.js             UI
sw.js                 offline cache of the app files (never sees data)
test/core.test.js     node --test test/*.test.js
```

## Tested (2026-11-06)
- `node --test test/*.test.js`: 17/17 (real alert formats, splitting, no duplicates, refunds, Shahid price change, Spotify cancelled, salary detection, Riyadh dates, unknown → Other, rules, backup validation).
- Chromium as iPhone 13 (Playwright): create password, add texts by typing and by clipboard, duplicates skipped, markup in merchant shown as text, IndexedDB and backup contain no readable data, reload → lock, wrong password refused, category change kept, salary/GOSI, backup download, change password, delete all, restore (wrong password refused), no horizontal scroll at 320/390px, zero requests outside the app, no console errors.
- **Not yet tested on a real iPhone** (Safari clipboard prompt, Add to Home Screen, the Shortcuts steps).
