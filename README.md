# StockNestio — Inventory Management

A small, dependency-free inventory and business snapshot app built from the supplied workbook.

## Open the app

Start the included local web server in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\run-app.ps1
```

Then open [http://localhost:8765](http://localhost:8765). Keep the PowerShell window open while using the app.

## Android app

The `android/` folder contains an Android Trusted Web Activity for the hosted app at `https://aaravisyumbox.themidastouche.com/`. Open that folder in Android Studio to build the APK. The web manifest and Digital Asset Links file are included in the web root; see [`android/README.md`](android/README.md) for the build, installation, and hosting steps.

## Publish on PHP hosting

The local PowerShell server is only for running the app on your own computer. For the hosted site, the frontend uses `api.php`; it needs PHP 7.4 or newer with the cURL extension enabled, HTTPS, and PHP write access to `App_Data`.

1. Upload the app files, the `assets/` logo directory, `api.php`, `oauth-callback.php`, `App_Data/google-oauth.example.php`, `App_Data/web.config`, and `App_Data/.htaccess` to the website root. Keep any hosting-provider `web.config` at the root unchanged. The access-control files inside `App_Data` protect the OAuth configuration and server-side session files.
2. In `App_Data`, copy `google-oauth.example.php` to `google-oauth.php`. Edit the copy in the hosting file manager: enter your Google Web OAuth client secret and set `app_base_url` to the exact HTTPS origin shown in the browser address bar (no trailing slash). Never commit or share `google-oauth.php`.
3. In Google Cloud Console, add that same origin under **Authorized JavaScript origins** and add `<your-exact-app-origin>/oauth-callback.php` under **Authorized redirect URIs**. The origin and callback must exactly match the StockNestio hosting address; a different hostname, path, or an `api.php?route=...` URL causes Google's `redirect_uri_mismatch` error. Keep the localhost entries too if you also use the local app.
4. Reload the hosted site. Sign in with Google, then enter the Google Sheet link. If sign-in fails, check that PHP cURL is enabled and that the PHP process can create/write `App_Data/yum-box-sessions`.

## Sign in and connect your Google Sheet

1. In Google Cloud Console, enable the Google Sheets API and configure the OAuth consent screen. For a Gmail account, set the audience to **External**. While the app is in **Testing**, add the Google account you will sign in with under **Test users**.
2. Create an OAuth client ID of type **Web application**. For local use, add `http://localhost:8765` under **Authorized JavaScript origins** and `http://localhost:8765/oauth/callback` under **Authorized redirect URIs**. For hosted use, also follow the hosted redirect URI setup above.
3. Keep the public client ID in `google-config.js`. In PowerShell, run `powershell -ExecutionPolicy Bypass -File .\configure-google.ps1` and enter the Web application's client secret at its hidden prompt. It is encrypted for your Windows account and stored outside the app folder; never put it in browser code or share it in chat.
4. Start `run-app.ps1` and open [http://localhost:8765](http://localhost:8765). Choose **Sign in with Google**, then authorize the account that can edit the workbook.
5. On first use, paste your Google Sheet link and choose **Open my sheet**. The dashboard appears only after the sheet loads successfully.

On the hosted site, Google sign-in opens a popup so you can select the Google account; when authorization finishes, the popup closes and the app continues. Google must have the exact hosted callback URL registered above. The local server uses a full-page sign-in redirect. It holds refresh tokens in memory; hosted PHP stores them in server-side session files under `App_Data`. Both use an HttpOnly session cookie for up to one day; after a browser refresh, the app loads the sheet again from Google without an additional sign-in. **Log out** revokes the Google token and ends the session immediately. On local use, restarting the PowerShell server clears sessions; hosted session files are managed by PHP.

If Google shows **Error 401: invalid_client** or **no registered origin**, open the OAuth client matching the ID in `google-config.js` and check that the correct localhost or hosted origin and redirect URI are registered. Save the change, wait a few minutes, and reload the app.

If Google shows **Error 403: access_denied** saying the app has not completed verification, check **Google Auth Platform → Audience → Test users** and add the exact account selected in the sign-in prompt. Save, then retry and accept the unverified-app warning if Google displays one. Public use beyond test users requires completing Google's verification for the Sheets scope.

The app uses the Google Sheets API through its local or hosted server. Google sign-in requests the `spreadsheets` scope to read and edit spreadsheets available to the authorizing account, plus basic OpenID profile information to show the signed-in user's name and picture; app requests target only the configured spreadsheet. The app does not share the workbook with another person. If the sheet is currently shared as "Anyone with the link", set **General access** to **Restricted** in Google Sheets to stop other link holders from reading it; OAuth does not change the sheet's existing sharing settings.

For another person to use a workbook, first share that Google Sheet with the exact Google account they sign into and grant **Editor** access. If the app reports insufficient Google Sheets permissions, use **Reconnect Google access**; this ends and revokes the existing app session before requesting consent again. Choose the account that has access to the workbook and approve the Google Sheets permission. If Google does not show the consent prompt or access is still denied, remove StockNestio from that account's Google Account connections and reconnect. Being able to sign in to Google alone does not grant access to a workbook.

Inventory, purchases, stock movements, payouts, and expenses are read from and written directly to Google Sheets. The app does not bundle a local workbook copy, save workbook data or OAuth tokens in browser storage, or provide offline mode. Only the selected sheet link is saved in this browser. OAuth tokens stay on the server; after one day, sign in again.

## What’s included

- Searchable inventory with low-stock and out-of-stock indicators, 10-row pagination, and interactive Excel export of all matching items. Edit inventory item details; on-hand stock is calculated from stock movement records and is not directly editable.
- Add inventory items with category-specific sub-category choices or create a new sub-category. Opening stock is recorded in the stock movement log.
- Stock adjustments that prevent stock from going below zero.
- Purchase entry that updates stock, purchase totals, and movement history together. Edit purchase records and automatically reconcile stock and purchase totals; unit cost is calculated from total cost divided by quantity.
- Paginated purchase history with search and interactive Excel export of all matching purchases; edit purchase details from the log while calculated values remain read-only.
- Searchable, paginated stock movement history with editable movement records that recalculate on-hand stock.
- Current date displayed in the app's top bar, including on mobile.
- Google account name, email, and profile photo in the signed-in user profile.
- Download the connected Google Sheet as an Excel workbook (`.xlsx`) with all tabs and formatting.
- Dedicated, searchable, paginated platform payout and employee/operating expense logs. Their entry forms capture the workbook's reference, notes, payment mode, and status fields, and their records can be edited and saved directly to the matching Google Sheets tabs.
- Platform payout and operating expense totals, with a live profit-and-loss summary.
- Monthly Payouts Summary matching the workbook's platform credits, purchase costs, operating expenses, total expenses, net profit/loss, and margin, with CSV export.
- Use Google Sheets' **File → Make a copy** or **Download** options to back up workbook data.

Stock adjustments, new items, purchases, stock movements, payouts, and expenses are written to their corresponding workbook tabs. Inventory on-hand formulas remain intact and are calculated from the stock movement log; change stock by recording or editing a movement. The workbook's revenue summary includes a payout that its log marks as pending; the app calls this out in the finance view.
