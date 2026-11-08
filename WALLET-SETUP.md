# Wallet and credit card texts: iPhone setup

For STC Pay, D360 Bank, urpay, barq and the ANB credit card. Each one gets its **own automation**, so your Al Rajhi automation isn't changed. Each one is built **the same way as the Al Rajhi automation**, with only the tag being different. All texts go into the same `bank-texts.txt` file, so none of them pushes another off the clipboard. When you unlock Finances and tap **Paste**, everything new is added.

## 1. A contact for each sender (once)

New iOS needs a Sender, and wallet senders are names, not numbers. Use the same trick as for Al Rajhi:
Contacts → **+** → name e.g. `ANB texts` → **add email** → type the sender name exactly as it shows at the top of the Messages chat → Done.

| Wallet | Sender to type in the email field |
|---|---|
| ANB credit card | `ANB` |
| urpay | `urpay` |
| STC Pay | `STC Bank` |
| D360 Bank | `D360 Bank` |
| barq | (to be confirmed) |

## 2. One automation per wallet

Shortcuts → Automation → **+** → **Message** → **Sender**: that contact → **Run Immediately** → New Blank Automation. Add three actions:

1. **Text**: the tag, then the **Message** variable. Nothing else.
2. **Append to Text File**: append that Text to **bank-texts.txt**, the same file your Al Rajhi automation uses, with **Make New Line** on.
3. **Copy to Clipboard**: copy the appended file, the same last step as in your Al Rajhi automation.

Tags (type them exactly, capitals included):

| Wallet | Tag |
|---|---|
| STC Pay | `##WALLET:STCPAY##` |
| D360 Bank | `##WALLET:D360##` |
| urpay | `##WALLET:URPAY##` |
| barq | `##WALLET:BARQ##` |
| ANB credit card | `##WALLET:ANB##` |

## 3. In the app

Open **Wallets** and tap each one once to enter its balance now (for the card: what you owe and the limit). After that, nothing to do: unlock and tap **Paste** as usual.

- ANB texts state the available credit, so the card always matches ANB. urpay texts have no balance, so each purchase or top-up is added or taken off.
- Money moved between Al Rajhi and a wallet, or a wallet top-up paid with the ANB card, is counted once, as a transfer between your own accounts.
- Texts the app couldn't read are listed inside that wallet and don't change its balance.
