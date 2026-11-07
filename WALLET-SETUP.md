# Wallet and credit card texts: iPhone setup

This is for STC Pay, D360 Bank, urpay, barq and the ANB credit card. It is separate from the Al Rajhi automation: that one stays exactly as it is.

How it works: each wallet's texts get their own tag (`##WALLET:STCPAY##` and so on) and go into their own file, `wallet-texts.txt`, in **On My iPhone › Finances**. That folder is on the phone only, not iCloud. The automation copies the wallet texts together with your Al Rajhi texts, so neither one hides the other on the clipboard. When you unlock Finances and tap **Paste**, both are added.

The file doesn't keep piling up. After the app has added the wallet texts, your next tap in the app puts a short "done" note on the clipboard. The next wallet text sees that note and empties the file before saving itself.

## 1. A contact for each sender (once)

New iOS needs a Sender for Message automations, and wallet senders are names, not numbers. Same trick as for Al Rajhi:
Contacts → **+** → First name e.g. `STC Pay texts` → **add email** → type the sender name exactly as it appears at the top of the Messages chat (e.g. `STC Pay`) → Done.

Do this for each one: STC Pay, D360, urpay, barq, ANB.

## 2. The "Wallet Saver" shortcut (once)

Shortcuts → **+** → name it **Wallet Saver**. Add these actions in order:

1. **Get Clipboard**
2. **If** *Clipboard* **contains** `##WALLET-DONE##`
   - **Text**: `-`
   - **Save File**: save that Text to **On My iPhone › Finances**, file name `wallet-texts.txt`, **Ask Where to Save** off, **Overwrite If File Exists** on
   - **End If**
3. **Text**: the **Shortcut Input** variable, then a new line, then `##AT## ` followed by the **Current Date** variable (tap it → Date Format **ISO 8601**, **Include Time** on)
4. **Append to Text File**: append that Text to `wallet-texts.txt` in **On My iPhone › Finances**, **Make New Line** on
5. **Get File**: `wallet-texts.txt` from **On My iPhone › Finances** (Show Document Picker off, Error If Not Found off)
6. **Get File**: `bank-texts.txt`, the file your Al Rajhi automation writes to (iCloud Drive), Error If Not Found off
7. **Text**: the file from step 5, a new line, then the file from step 6
8. **Copy to Clipboard**: the Text from step 7

The first time it runs, iOS may ask to allow clipboard access: choose **Always Allow**.

## 3. One automation per wallet

Shortcuts → Automation → **+** → **Message** → **Sender**: the contact from step 1 → **Run Immediately** (Notify When Run off) → New Blank Automation:

1. **Text**: the tag, then a new line, then **Shortcut Input** (set to **Content**)
2. **Run Shortcut**: **Wallet Saver**, with the Text as input

Tags (type them exactly, capitals included):

| Wallet | Tag |
|---|---|
| STC Pay | `##WALLET:STCPAY##` |
| D360 Bank | `##WALLET:D360##` |
| urpay | `##WALLET:URPAY##` |
| barq | `##WALLET:BARQ##` |
| ANB credit card | `##WALLET:ANB##` |

## 4. In the app

Open **Wallets** and tap each one to enter its balance now (for the card: what you owe now, and the limit if you want "available" shown). After that, unlock and tap **Paste** as usual. You can also use **Paste wallet texts** on the Wallets tab.

- A text that states the balance resets the balance to that amount. Other texts add or take off their amount.
- If a balance ever looks off, tap the wallet and type the right amount; texts after that point carry on from it.
- Moving money between Al Rajhi and a wallet or the card (same amount, within a few days) is counted once, as a transfer between your own accounts. It doesn't count as spending, income or "sent to people".
- Texts the app couldn't read are listed inside that wallet and don't change its balance.
