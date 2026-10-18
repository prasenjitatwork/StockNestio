(function () {
  "use strict";

  const GOOGLE_SETTINGS_KEY = "stocknest-google-settings-v1";
  const THEME_KEY = "stocknest-theme-v1";
  const storedSetting = (key, legacyKey) => {
    const current = localStorage.getItem(key);
    if (current !== null) return current;
    const legacy = localStorage.getItem(legacyKey);
    if (legacy !== null) localStorage.setItem(key, legacy);
    return legacy;
  };
  const savedGoogleSettings = storedSetting(GOOGLE_SETTINGS_KEY, "aaravis-yum-box-google-settings-v1");
  const savedTheme = storedSetting(THEME_KEY, "aaravis-yum-box-theme-v1") === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = savedTheme;
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const hasSavedSheet = Boolean(savedGoogleSettings);
  const isLocalServer = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  const apiUrl = (route) => isLocalServer
    ? `/api/${route}`
    : `/api.php?route=${encodeURIComponent(route)}`;
  let state = null;
  let googleSettings = { sheetId: "" };
  try {
    googleSettings = { ...googleSettings, ...JSON.parse(savedGoogleSettings || "{}") };
  } catch (error) {
    console.error("Saved Google connection settings could not be loaded.", error);
  }

  function showSheetAccessError(message) {
    const needsReauthorization = /insufficient authentication scopes|access_token_scope_insufficient/i.test(message);
    get("sheet-link-error").textContent = needsReauthorization
      ? "Google signed you in without the permission needed to read this sheet. Reconnect Google and approve spreadsheet access."
      : message;
    get("sheet-link-error").classList.remove("hidden");
    get("reauthorize-google-button").classList.toggle("hidden", !needsReauthorization);
  }

  function showReauthorizationPrompt(message) {
    const googleDialog = get("google-dialog");
    if (googleDialog.open) googleDialog.close();
    get("login-step-signin").classList.add("hidden");
    get("google-sheet-form").classList.remove("hidden");
    showLoginPage(true);
    showSheetAccessError(message);
  }
  let sessionExpiresAt = 0;
  let googleAccountEmail = "";
  let googleAccountName = "";
  let googleAccountPicture = "";
  let googleLoginPopup = null;
  let sheetRows = { inventory: {}, inventoryNext: 8, purchasesNext: 8, movementsNext: 5, payoutsNext: 8, expensesNext: 8 };
  let sheetIds = {};
  let expenseSheetTitle = "Employee payment and other expe";
  const money = (amount) => new Intl.NumberFormat("en-IN", {
    style: "currency", currency: "INR", maximumFractionDigits: 2
  }).format(Number(amount) || 0);
  const number = (amount) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(Number(amount) || 0);
  const dateLabel = (date) => date ? new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(`${date}T00:00:00`)) : "—";
  const today = () => {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
  const newestFirst = (entries) => entries.map((entry, index) => ({ entry, index }))
    .sort((a, b) => String(b.entry.date).localeCompare(String(a.entry.date)) || b.index - a.index)
    .map(({ entry }) => entry);
  let inventoryFilter = "all";
  let inventoryPage = 1;
  let movementPage = 1;
  let purchasePage = 1;
  let payoutPage = 1;
  let expensePage = 1;
  const tablePageSize = 10;
  let toastTimer;

  const get = (id) => document.getElementById(id);
  const sumAmount = (entries, key) => entries.reduce((sum, entry) => sum + (Number(entry[key]) || 0), 0);
  const totalExpenses = () => state.expenses.reduce((sum, entry) => sum + Number(entry.amount), 0);
  const totalRevenue = () => state.financials.revenue;
  const totalPurchases = () => state.financials.purchases;
  const netProfit = () => totalRevenue() - totalPurchases() - totalExpenses();
  const lowItems = () => state.inventory.filter((item) => Number(item.stock) <= 2);
  const statusFor = (stock) => Number(stock) <= 0 ? ["Out of stock", "empty"] : Number(stock) <= 2 ? ["Low stock", "low"] : ["In stock", ""];

  function updateConnectionUI(connected) {
    get("google-connection-label").textContent = connected ? "Google Sheet connected" : "Connect Google Sheet";
    get("google-connection-detail").textContent = connected ? "Changes sync to your workbook" : "Sign in to sync this workbook";
    get("google-top-button").innerHTML = connected ? "↻ <span>Refresh sheet</span>" : "↗ <span>Connect sheet</span>";
    get("logout-button").classList.toggle("hidden", !connected);
  }

  function updateGoogleProfile(session) {
    googleAccountEmail = typeof session.email === "string" ? session.email : "";
    googleAccountName = typeof session.name === "string" ? session.name.trim() : "";
    googleAccountPicture = typeof session.picture === "string" ? session.picture : "";
    const fallbackName = googleAccountEmail.split("@")[0] || "Google account";
    const displayName = googleAccountName || fallbackName;
    const initials = displayName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
    get("google-profile-name").textContent = displayName;
    get("google-profile-detail").textContent = googleAccountEmail || "Signed in with Google";
    get("google-account-label").textContent = googleAccountEmail || displayName;

    const image = get("google-profile-picture");
    const fallback = get("google-profile-initials");
    const safePicture = /^https:\/\/(?:[a-z0-9-]+\.)*googleusercontent\.com(?:\/|$)/i.test(googleAccountPicture);
    image.onerror = () => {
      image.classList.add("hidden");
      fallback.classList.remove("hidden");
    };
    if (safePicture) {
      image.alt = `Google profile photo for ${displayName}`;
      image.src = googleAccountPicture;
      image.classList.remove("hidden");
      fallback.classList.add("hidden");
    } else {
      image.removeAttribute("src");
      image.classList.add("hidden");
      fallback.classList.remove("hidden");
    }
    fallback.textContent = initials || "SN";
  }

  function updateThemeToggle(theme) {
    const isDark = theme === "dark";
    document.documentElement.dataset.theme = theme;
    get("theme-toggle").setAttribute("aria-label", `Switch to ${isDark ? "light" : "dark"} theme`);
    get("theme-toggle").title = `Switch to ${isDark ? "light" : "dark"} theme`;
    get("theme-toggle-icon").textContent = isDark ? "☀" : "◐";
    get("theme-toggle-label").textContent = isDark ? "Light mode" : "Dark mode";
  }

  function showLoginPage(visible) {
    get("google-login-page").classList.toggle("hidden", !visible);
    document.querySelector(".app-shell").classList.toggle("hidden", visible);
  }

  function updateLoginError(message) {
    get("login-error").textContent = message;
    get("login-error").classList.remove("hidden");
  }

  function resetLoginFlow() {
    get("login-step-signin").classList.remove("hidden");
    get("google-sheet-form").classList.add("hidden");
    get("login-error").classList.add("hidden");
    get("sheet-link-error").classList.add("hidden");
    get("reauthorize-google-button").classList.add("hidden");
    get("load-google-sheet-button").disabled = false;
    get("load-google-sheet-button").textContent = "Open my sheet";
    get("login-google-button").disabled = false;
    get("login-google-button").innerHTML = '<span class="google-g login-google-g">G</span> Sign in with Google';
    get("login-sheet-id").value = googleSettings.sheetId;
  }

  async function endGoogleSession() {
    const button = get("logout-button");
    button.disabled = true;
    try {
      const response = await fetch(apiUrl("auth/logout"), { method: "POST" });
      if (!response.ok) throw new Error(`Logout returned HTTP ${response.status}.`);
      state = null;
      sessionExpiresAt = 0;
      googleAccountEmail = "";
      googleAccountName = "";
      googleAccountPicture = "";
      updateGoogleProfile({});
      sheetRows = { inventory: {}, inventoryNext: 8, purchasesNext: 8, movementsNext: 5, payoutsNext: 8, expensesNext: 8 };
      sheetIds = {};
      resetLoginFlow();
      showLoginPage(true);
      updateConnectionUI(false);
    } catch (error) {
      toast(`Could not log out: ${error.message}`);
    } finally {
      button.disabled = false;
    }
    if (get("google-dialog").open) get("google-dialog").close();
  }

  function openGoogleSettings() {
    get("google-sheet-id").value = googleSettings.sheetId;
    updateWorkbookDownloadLink(googleSettings.sheetId);
    get("google-login-error").classList.add("hidden");
    get("google-dialog").showModal();
  }

  function updateWorkbookDownloadLink(value) {
    const sheetId = spreadsheetIdFromInput(value);
    const link = get("download-google-sheet");
    const isValidId = /^[a-zA-Z0-9-_]+$/.test(sheetId);
    if (!isValidId) {
      link.removeAttribute("href");
      link.classList.add("hidden");
      return;
    }
    link.href = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/export?format=xlsx`;
    link.classList.remove("hidden");
  }

  function showGoogleError(message) {
    const element = get("google-login-error");
    element.textContent = message;
    element.classList.remove("hidden");
  }

  function spreadsheetIdFromInput(value) {
    const input = value.trim();
    const match = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    return match ? match[1] : input;
  }

  function startGoogleLogin() {
    if (isLocalServer) {
      window.location.assign(apiUrl("auth/login"));
      return;
    }

    const popup = window.open(
      `${apiUrl("auth/login")}&popup=1`,
      "stocknest-google-login",
      "popup,width=520,height=680,resizable=yes,scrollbars=yes"
    );
    if (!popup) {
      window.location.assign(apiUrl("auth/login"));
      return;
    }
    googleLoginPopup = popup;
    popup.focus();
  }

  async function sheetsRequest(path, options = {}) {
    const queryIndex = path.indexOf("?");
    const routePath = queryIndex < 0 ? path : path.slice(0, queryIndex);
    const query = queryIndex < 0 ? "" : `&${path.slice(queryIndex + 1)}`;
    const endpoint = isLocalServer
      ? `/api/sheets/v4/spreadsheets/${encodeURIComponent(googleSettings.sheetId)}${path}`
      : `${apiUrl(`sheets/v4/spreadsheets/${encodeURIComponent(googleSettings.sheetId)}${routePath}`)}${query}`;
    const response = await fetch(endpoint, {
      ...options,
      headers: { ...(options.headers || {}) }
    });
    if (response.status === 401) {
      await endGoogleSession();
      throw new Error("Your Google session expired. Log in again to continue.");
    }
    const data = await response.json();
    if (!response.ok) {
      const apiMessage = data?.error?.message || `Google Sheets returned HTTP ${response.status}.`;
      throw new Error(apiMessage);
    }
    return data;
  }

  function valueAt(rows, row, column) {
    return rows[row]?.[column] ?? "";
  }

  function asNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  const unitCostFor = (cost, quantity) => Number(quantity) > 0 ? Number(cost) / Number(quantity) : 0;

  function sheetDate(value) {
    if (!value) return "";
    if (typeof value === "number") return new Date(Date.UTC(1899, 11, 30) + value * 86400000).toISOString().slice(0, 10);
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
  }

  function dateSerial(value) {
    if (!value) return "";
    return Math.floor((Date.parse(`${value}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000);
  }

  function nextSheetRow(rows, firstRow) {
    let last = firstRow - 1;
    rows.forEach((row, index) => {
      if (row.some((value) => value !== "" && value !== null && value !== undefined)) last = index + 1;
    });
    return last + 1;
  }

  function nextRecordRow(rows, column, firstRow) {
    let next = firstRow;
    rows.forEach((row, index) => {
      if (index + 1 >= firstRow && row[column]) next = index + 2;
    });
    return next;
  }

  function resolveExpenseSheetTitle(sheets) {
    const titles = sheets.map((sheet) => sheet.properties.title);
    if (titles.includes(expenseSheetTitle)) return expenseSheetTitle;
    const candidates = titles.filter((title) => /employee/i.test(title) && /payment/i.test(title) && /other/i.test(title));
    if (candidates.length === 1) return candidates[0];
    const available = titles.length ? titles.join(", ") : "none";
    if (candidates.length > 1) {
      throw new Error(`More than one expense tab could match this workbook (${candidates.join(", ")}). Rename the correct tab to "Employee payment and other expe" and retry.`);
    }
    throw new Error(`Could not find the workbook's employee payment and expenses tab. Available tabs: ${available}. Rename that tab to "Employee payment and other expe" and retry.`);
  }

  function quoteSheetTitle(title) {
    return `'${title.replace(/'/g, "''")}'`;
  }

  async function loadSpreadsheet() {
    const metadata = await sheetsRequest("?fields=sheets.properties(sheetId,title)");
    if (!Array.isArray(metadata.sheets)) {
      throw new Error("Google did not return the spreadsheet tab list. Check that this is a Google Sheets workbook and try again.");
    }
    expenseSheetTitle = resolveExpenseSheetTitle(metadata.sheets);
    const ranges = [
      "'Inventory Master'!B:G",
      "'Purchases & Inward Log'!B:K",
      "'Stock Movement Log'!B:G",
      "'Online Payouts Log'!B:G",
      `${quoteSheetTitle(expenseSheetTitle)}!B:I`,
      "'Profit & Loss Summary'!B5:I19"
    ];
    const query = new URLSearchParams();
    ranges.forEach((range) => query.append("ranges", range));
    query.set("valueRenderOption", "UNFORMATTED_VALUE");
    const result = await sheetsRequest(`/values:batchGet?${query.toString()}`);
    if (!Array.isArray(result.valueRanges) || result.valueRanges.length !== ranges.length) {
      throw new Error("Google returned incomplete workbook data. Check that the sheet tabs still match the workbook.");
    }
    const [inventoryRows, purchaseRows, movementRows, payoutRows, expenseRows, summaryRows] = result.valueRanges.map((entry) => entry.values || []);
    sheetIds = Object.fromEntries(metadata.sheets.map((sheet) => [sheet.properties.title, sheet.properties.sheetId]));

    const inventory = [];
    const inventoryMap = {};
    inventoryRows.forEach((row, index) => {
      if (index < 7 || !valueAt(inventoryRows, index, 0)) return;
      const name = String(row[0]).trim();
      inventory.push({
        _sheetRow: index + 1,
        name,
        category: String(row[1] || ""),
        subcategory: String(row[2] || ""),
        unit: String(row[3] || "Unit"),
        stock: asNumber(row[4]),
        company: String(row[5] || "").trim()
      });
      inventoryMap[name] = index + 1;
    });
    if (!inventory.length) throw new Error("No inventory items were found in the Inventory Master tab.");
    const purchaseFooterIndex = purchaseRows.findIndex((row) => /total logged purchases/i.test(String(row[0] || "")));
    const purchaseFooterRow = purchaseFooterIndex >= 0 ? purchaseFooterIndex + 1 : 0;

    const purchases = purchaseRows.slice(7).map((row, index) => ({ row, sheetRow: index + 8 }))
      .filter(({ row }) => row[2]).map(({ row, sheetRow }) => ({
      _sheetRow: sheetRow,
      date: sheetDate(row[0]),
      category: String(row[1] || ""),
      item: String(row[2]).trim(),
      packets: asNumber(row[3]),
      cost: asNumber(row[4]),
      quantity: asNumber(row[5]),
      unitCost: unitCostFor(row[4], row[5]),
      expiry: String(row[7] || ""),
      vendor: String(row[8] || ""),
      company: String(row[9] || "")
    }));
    const movements = movementRows.slice(4).map((row, index) => ({ row, sheetRow: index + 5 }))
      .filter(({ row }) => row[1]).map(({ row, sheetRow }) => ({
      _sheetRow: sheetRow,
      date: sheetDate(row[0]),
      item: String(row[1]).trim(),
      type: /out/i.test(String(row[2])) ? "out" : "in",
      quantity: asNumber(row[3]),
      staff: String(row[4] || ""),
      notes: String(row[5] || "")
    }));
    const payouts = payoutRows.slice(7).map((row, index) => ({ row, sheetRow: index + 8 }))
      .filter(({ row }) => row[1]).map(({ row, sheetRow }) => ({
      _sheetRow: sheetRow,
      date: sheetDate(row[0]),
      platform: String(row[1]),
      amount: asNumber(row[2]),
      status: String(row[3] || ""),
      reference: String(row[4] || ""),
      notes: String(row[5] || "")
    }));
    const expenses = expenseRows.slice(7).map((row, index) => ({ row, sheetRow: index + 8 }))
      .filter(({ row }) => row[1]).map(({ row, sheetRow }) => ({
      _sheetRow: sheetRow,
      date: sheetDate(row[0]),
      category: String(row[1]),
      beneficiary: String(row[2] || ""),
      description: String(row[3] || ""),
      amount: asNumber(row[4]),
      mode: String(row[5] || ""),
      status: String(row[6] || ""),
      notes: String(row[7] || "")
    }));
    const summary = (row, column) => asNumber(valueAt(summaryRows, row - 5, column));
    const platforms = {};
    [8, 9, 10, 11].forEach((row) => {
      const name = String(valueAt(summaryRows, row - 5, 1)).replace(" Settlement Credits", "").trim();
      const amount = summary(row, 5);
      if (name) platforms[name] = amount;
    });
    sheetRows = {
      inventory: inventoryMap,
      inventoryNext: nextSheetRow(inventoryRows, 8),
      purchasesNext: nextRecordRow(purchaseRows, 2, 8),
      purchaseFooterRow,
      movementsNext: nextSheetRow(movementRows, 5),
      payoutsNext: nextSheetRow(payoutRows, 8),
      expensesNext: nextSheetRow(expenseRows, 8)
    };
    return {
      inventory, purchases, movements, payouts, expenses,
      financials: {
        revenue: summary(5, 0),
        purchases: summary(5, 2),
        expenses: summary(5, 4),
        profit: summary(5, 6),
        platforms,
        expenseBreakdown: { wages: summary(14, 5), utilities: summary(15, 5), other: summary(16, 5) }
      }
    };
  }

  async function connectGoogleSheet() {
    const sheetId = spreadsheetIdFromInput(get("login-sheet-id").value);
    if (!/^[a-zA-Z0-9-_]+$/.test(sheetId)) {
      get("sheet-link-error").textContent = "Enter a valid Google Sheet link or spreadsheet ID.";
      get("sheet-link-error").classList.remove("hidden");
      return;
    }
    const button = get("load-google-sheet-button");
    googleSettings.sheetId = sheetId;
    button.disabled = true;
    button.textContent = "Loading your sheet…";
    get("sheet-link-error").classList.add("hidden");
    try {
      const remote = await loadSpreadsheet();
      state = remote;
      localStorage.setItem(GOOGLE_SETTINGS_KEY, JSON.stringify({ sheetId }));
      render();
      updateConnectionUI(true);
      showLoginPage(false);
      toast("Google Sheet connected. Changes will sync to your workbook.");
    } catch (error) {
      if (sessionExpiresAt) {
        if (/insufficient authentication scopes|access_token_scope_insufficient/i.test(error.message)) {
          showReauthorizationPrompt(error.message);
        } else {
          showSheetAccessError(error.message);
        }
      } else {
        updateLoginError(error.message);
      }
    } finally {
      button.disabled = false;
      button.textContent = "Open my sheet";
    }
  }

  async function syncSpreadsheetChanges(before, after) {
    const updates = [];
    const nextRows = { ...sheetRows, inventory: { ...sheetRows.inventory } };
    const rowAssignments = [];
    const newPurchases = after.purchases.filter((entry) => !entry._sheetRow);
    if (newPurchases.length && nextRows.purchaseFooterRow) {
      const requiredRows = Math.max(0, nextRows.purchasesNext + newPurchases.length - nextRows.purchaseFooterRow);
      if (requiredRows) {
        const purchaseSheetId = sheetIds["Purchases & Inward Log"];
        if (purchaseSheetId === undefined) throw new Error("Google could not identify the Purchases & Inward Log tab.");
        await sheetsRequest(":batchUpdate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requests: [{
            insertDimension: {
              range: {
                sheetId: purchaseSheetId,
                dimension: "ROWS",
                startIndex: nextRows.purchaseFooterRow - 1,
                endIndex: nextRows.purchaseFooterRow - 1 + requiredRows
              },
              inheritFromBefore: true
            }
          }] })
        });
        nextRows.purchaseFooterRow += requiredRows;
        sheetRows.purchaseFooterRow = nextRows.purchaseFooterRow;
      }
    }
    if (after.payouts.length > 0 && nextRows.payoutsNext + after.payouts.length - before.payouts.length - 1 > 100) {
      throw new Error("The payout log reached the end of its summary formula range. Extend the log and its totals in Google Sheets.");
    }
    if (after.expenses.length > 0 && nextRows.expensesNext + after.expenses.length - before.expenses.length - 1 > 96) {
      throw new Error("The expense log reached the end of its summary formula range. Extend the log and its totals in Google Sheets.");
    }
    const newInventoryRows = [];
    after.inventory.forEach((item) => {
      const previous = before.inventory.find((entry) => entry._sheetRow === item._sheetRow && entry._sheetRow);
      const row = item._sheetRow;
      if (!previous) {
        newInventoryRows.push(item);
      } else {
        const previousCatalog = [previous.name, previous.category, previous.subcategory, previous.unit, previous.company || ""];
        const catalog = [item.name, item.category, item.subcategory, item.unit, item.company || ""];
        if (JSON.stringify(previousCatalog) !== JSON.stringify(catalog)) {
          updates.push({ range: `'Inventory Master'!B${row}:E${row}`, values: [catalog.slice(0, 4)] });
          updates.push({ range: `'Inventory Master'!G${row}`, values: [[catalog[4]]] });
        }
      }
    });
    newInventoryRows.forEach((item) => {
      const row = nextRows.inventoryNext++;
      updates.push({ range: `'Inventory Master'!B${row}:E${row}`, values: [[item.name, item.category, item.subcategory, item.unit]] });
      updates.push({
        range: `'Inventory Master'!F${row}`,
        values: [[`=IF(B${row}="","",(SUMIFS('Stock Movement Log'!$E:$E,'Stock Movement Log'!$C:$C,TRIM(B${row}&" "&G${row}),'Stock Movement Log'!$D:$D,"Stock In*")-SUMIFS('Stock Movement Log'!$E:$E,'Stock Movement Log'!$C:$C,TRIM(B${row}&" "&G${row}),'Stock Movement Log'!$D:$D,"Stock Out*"))+IF(G${row}<>"",SUMIFS('Stock Movement Log'!$E:$E,'Stock Movement Log'!$C:$C,B${row},'Stock Movement Log'!$D:$D,"Stock In*")-SUMIFS('Stock Movement Log'!$E:$E,'Stock Movement Log'!$C:$C,B${row},'Stock Movement Log'!$D:$D,"Stock Out*"),0))`]]
      });
      updates.push({ range: `'Inventory Master'!G${row}`, values: [[item.company || ""]] });
      rowAssignments.push([item, row]);
    });
    const updatedPurchases = after.purchases.filter((entry) => entry._sheetRow
      && JSON.stringify(before.purchases.find((old) => old._sheetRow === entry._sheetRow)) !== JSON.stringify(entry));
    [...updatedPurchases, ...newPurchases].forEach((entry) => {
      const row = entry._sheetRow || nextRows.purchasesNext++;
      if (!entry._sheetRow) rowAssignments.push([entry, row]);
      updates.push({ range: `'Purchases & Inward Log'!B${row}:G${row}`, values: [[
        dateSerial(entry.date), entry.category, entry.item, Number(entry.packets) || 0,
        Number(entry.cost), Number(entry.quantity)
      ]] });
      updates.push({
        range: `'Purchases & Inward Log'!H${row}`,
        values: [[`=IF(OR(ISBLANK(F${row}),G${row}=0),"",F${row}/G${row})`]]
      });
      updates.push({ range: `'Purchases & Inward Log'!I${row}:K${row}`, values: [[
        entry.expiry || "", entry.vendor || "", entry.company || ""
      ]] });
    });
    const updateExistingRows = (collection, columns, valuesFor) => {
      const beforeByRow = new Map(before[collection].filter((entry) => entry._sheetRow).map((entry) => [entry._sheetRow, entry]));
      const newEntries = after[collection].filter((entry) => !entry._sheetRow);
      after[collection].forEach((entry) => {
        if (!entry._sheetRow) return;
        const previous = beforeByRow.get(entry._sheetRow);
        if (previous && JSON.stringify(valuesFor(previous)) !== JSON.stringify(valuesFor(entry))) {
          updates.push({ range: `${collection === "movements" ? "'Stock Movement Log'" : collection === "payouts" ? "'Online Payouts Log'" : quoteSheetTitle(expenseSheetTitle)}!B${entry._sheetRow}:${columns}${entry._sheetRow}`, values: [valuesFor(entry)] });
        }
      });
      newEntries.forEach((entry) => {
        const rowKey = collection === "movements" ? "movementsNext" : collection === "payouts" ? "payoutsNext" : "expensesNext";
        const row = nextRows[rowKey]++;
        const title = collection === "movements" ? "'Stock Movement Log'" : collection === "payouts" ? "'Online Payouts Log'" : quoteSheetTitle(expenseSheetTitle);
        updates.push({ range: `${title}!B${row}:${columns}${row}`, values: [valuesFor(entry)] });
        rowAssignments.push([entry, row]);
      });
    };
    updateExistingRows("movements", "G", (entry) => [
      dateSerial(entry.date), entry.item, entry.type === "out" ? "Stock Out (-)" : "Stock In (+)", Number(entry.quantity),
      entry.staff || "", entry.notes || ""
    ]);
    updateExistingRows("payouts", "G", (entry) => [
      dateSerial(entry.date), entry.platform, Number(entry.amount), entry.status || "", entry.reference || "", entry.notes || ""
    ]);
    updateExistingRows("expenses", "I", (entry) => [
      dateSerial(entry.date), entry.category, entry.beneficiary || "", entry.description || "", Number(entry.amount),
      entry.mode || "", entry.status || "", entry.notes || ""
    ]);
    const purchaseChanges = newPurchases.length || updatedPurchases.length;
    if (purchaseChanges && nextRows.purchaseFooterRow) {
      const totals = after.purchases.reduce((sum, entry) => ({
        packets: sum.packets + (Number(entry.packets) || 0),
        cost: sum.cost + (Number(entry.cost) || 0),
        quantity: sum.quantity + (Number(entry.quantity) || 0)
      }), { packets: 0, cost: 0, quantity: 0 });
      updates.push({
        range: `'Purchases & Inward Log'!E${nextRows.purchaseFooterRow}:G${nextRows.purchaseFooterRow}`,
        values: [[totals.packets, totals.cost, totals.quantity]]
      });
      updates.push({
        range: `'Purchases & Inward Log'!H${nextRows.purchaseFooterRow}`,
        values: [[`=IF(OR(ISBLANK(F${nextRows.purchaseFooterRow}),G${nextRows.purchaseFooterRow}=0),"",F${nextRows.purchaseFooterRow}/G${nextRows.purchaseFooterRow})`]]
      });
    }
    if (!updates.length) return;
    await sheetsRequest("/values:batchUpdate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ valueInputOption: "USER_ENTERED", data: updates })
    });
    rowAssignments.forEach(([entry, row]) => {
      entry._sheetRow = row;
    });
    nextRows.inventory = Object.fromEntries(after.inventory.filter((item) => item._sheetRow)
      .map((item) => [item.name, item._sheetRow]));
    sheetRows = nextRows;
  }

  function toast(message) {
    const element = get("toast");
    element.textContent = message;
    element.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove("show"), 2800);
  }

  function render() {
    renderDashboard();
    renderInventory();
    renderMovements();
    renderPurchases();
    renderPayoutLog();
    renderExpenseLog();
    renderFinance();
    get("nav-low-count").textContent = lowItems().length || "";
    get("today-label").textContent = `Today · ${new Intl.DateTimeFormat("en-IN", {
      weekday: "short", day: "numeric", month: "short", year: "numeric"
    }).format(new Date())}`;
    get("today-label").dateTime = today();
  }

  function renderDashboard() {
    const low = lowItems();
    const food = state.inventory.filter((item) => item.category === "Food").length;
    get("metric-profit").textContent = money(netProfit());
    get("metric-revenue").textContent = money(totalRevenue());
    get("metric-low").textContent = number(low.length);
    get("metric-items").textContent = number(state.inventory.length);
    get("profit-margin").textContent = `${totalRevenue() ? (netProfit() / totalRevenue() * 100).toFixed(1) : "0.0"}%`;
    get("payout-count").textContent = number(state.payouts.length);
    get("out-of-stock-count").textContent = number(state.inventory.filter((item) => Number(item.stock) <= 0).length);
    get("food-count").textContent = number(food);
    get("packaging-count").textContent = number(state.inventory.length - food);

    const platformEntries = Object.entries(state.financials.platforms);
    const platformColors = { Swiggy: "#ef8e53", Zomato: "#d96b67", Magicpin: "#967ac2", Ownly: "#6e91a8" };
    const platformTotal = platformEntries.reduce((sum, [, value]) => sum + Number(value), 0) || 1;
    get("platform-chart").innerHTML = platformEntries.map(([name, value]) => `
      <div class="platform-row">
        <div class="platform-name"><i class="platform-dot" style="background:${platformColors[name] || "#719981"}"></i>${escapeHtml(name)}</div>
        <div class="platform-track"><div class="platform-bar" style="width:${Math.max(1, value / platformTotal * 100)}%;background:${platformColors[name] || "#719981"}"></div></div>
        <strong class="platform-value">${money(value)}</strong>
      </div>`).join("");
    get("dashboard-finance-summary").innerHTML = `
      <div class="summary-pair"><span>Inventory purchases</span><strong>${money(totalPurchases())}</strong></div>
      <div class="summary-pair"><span>Operating costs</span><strong>${money(totalExpenses())}</strong></div>
      <div class="summary-pair"><span>Net margin</span><strong>${totalRevenue() ? (netProfit() / totalRevenue() * 100).toFixed(1) : "0.0"}%</strong></div>`;

    const lowMarkup = low.slice(0, 5).map((item) => `
      <div class="low-stock-row"><div class="low-stock-item"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.subcategory)}</small></div><span class="stock-qty">${number(item.stock)} ${escapeHtml(item.unit)}</span></div>`).join("");
    get("low-stock-list").innerHTML = lowMarkup || '<div class="empty-inline">Everything is comfortably stocked.</div>';

    const movements = newestFirst(state.movements).slice(0, 5);
    get("recent-activity").innerHTML = movements.map((entry) => `
      <div class="activity-row"><div class="activity-main"><strong>${escapeHtml(entry.item)}</strong><small>${dateLabel(entry.date)} · ${escapeHtml(entry.staff || "Stockroom")}</small></div><span class="activity-amount ${entry.type === "out" ? "activity-tag out" : "activity-tag"}">${entry.type === "out" ? "−" : "+"}${number(entry.quantity)}</span></div>`).join("") || '<div class="empty-inline">No stock activity recorded yet.</div>';

    const purchases = newestFirst(state.purchases).slice(0, 4);
    get("recent-purchases").innerHTML = purchases.map((entry) => `
      <div class="purchase-mini-row"><div class="purchase-mini-main"><strong>${escapeHtml(entry.item)}</strong><small>${escapeHtml(entry.vendor || "Vendor not set")} · ${dateLabel(entry.date)}</small></div><span class="activity-amount">${money(entry.cost)}</span></div>`).join("") || '<div class="empty-inline">No purchases recorded yet.</div>';
  }

  function filteredInventory() {
    const query = get("inventory-search").value.trim().toLowerCase();
    return state.inventory.filter((item) => {
      const matchesText = [item.name, item.category, item.subcategory, item.company].join(" ").toLowerCase().includes(query);
      const matchesFilter = inventoryFilter === "all"
        || (inventoryFilter === "low" && Number(item.stock) <= 2)
        || item.category === inventoryFilter;
      return matchesText && matchesFilter;
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  function renderInventory() {
    const filtered = filteredInventory();
    get("inventory-result-count").textContent = `${number(filtered.length)} ${filtered.length === 1 ? "item" : "items"}`;
    get("filter-all-count").textContent = state.inventory.length;
    get("filter-low-count").textContent = lowItems().length;
    get("inventory-empty").classList.toggle("hidden", filtered.length > 0);
    const pageCount = Math.max(1, Math.ceil(filtered.length / tablePageSize));
    inventoryPage = Math.min(inventoryPage, pageCount);
    const start = (inventoryPage - 1) * tablePageSize;
    const pageItems = filtered.slice(start, start + tablePageSize);
    get("inventory-table").innerHTML = pageItems.map((item) => {
      const [label, status] = statusFor(item.stock);
      const icon = item.category === "Food" ? "✿" : "▤";
      return `<tr>
        <td class="row-actions"><button class="row-action" data-edit-inventory="${item._sheetRow || ""}">Edit</button><button class="row-action" data-adjust="${escapeHtml(item.name)}">Adjust</button></td>
        <td><div class="item-cell"><span class="item-thumb ${item.category === "Packaging" ? "packaging" : ""}">${icon}</span><span class="item-name"><strong title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong><small>${escapeHtml(item.subcategory)}</small></span></div></td>
        <td><span class="category-pill ${item.category === "Packaging" ? "packaging" : ""}">${escapeHtml(item.category)}</span></td>
        <td>${escapeHtml(item.company || "—")}</td>
        <td class="stock-cell">${number(item.stock)}<small>${escapeHtml(item.unit)}</small></td>
        <td><span class="status-pill ${status}">${label}</span></td>
      </tr>`;
    }).join("");
    renderPagination("inventory-pagination", filtered.length, inventoryPage, (page) => {
      inventoryPage = page;
      renderInventory();
    });
  }

  function renderMovements() {
    const query = get("movement-search").value.trim().toLowerCase();
    const matches = newestFirst(state.movements).filter((entry) =>
      [entry.date, dateLabel(entry.date), entry.item, entry.type, entry.quantity, entry.staff, entry.notes]
        .join(" ").toLowerCase().includes(query));
    get("movement-result-count").textContent = `${number(matches.length)} ${matches.length === 1 ? "movement" : "movements"}`;
    get("movement-empty").classList.toggle("hidden", matches.length > 0);
    const pageCount = Math.max(1, Math.ceil(matches.length / tablePageSize));
    movementPage = Math.min(movementPage, pageCount);
    const start = (movementPage - 1) * tablePageSize;
    get("movement-table").innerHTML = matches.slice(start, start + tablePageSize).map((entry) => `
      <tr><td><button class="row-action" data-edit-movement="${entry._sheetRow || ""}">Edit</button></td><td>${dateLabel(entry.date)}</td><td>${escapeHtml(entry.item)}</td><td>${entry.type === "out" ? "Stock out" : "Stock in"}</td><td class="stock-cell">${number(entry.quantity)}</td><td>${escapeHtml(entry.staff || "—")}</td><td>${escapeHtml(entry.notes || "—")}</td></tr>`).join("");
    renderPagination("movement-pagination", matches.length, movementPage, (page) => {
      movementPage = page;
      renderMovements();
    });
  }

  function filteredPurchases() {
    const query = get("purchase-search").value.trim().toLowerCase();
    return newestFirst(state.purchases).filter((entry) =>
      [entry.item, entry.vendor, entry.category, entry.company].join(" ").toLowerCase().includes(query));
  }

  function renderPurchases() {
    const matches = filteredPurchases();
    const units = state.purchases.reduce((sum, entry) => sum + Number(entry.quantity), 0);
    get("purchase-total").textContent = money(totalPurchases());
    get("purchase-entry-count").textContent = number(state.purchases.length);
    get("purchase-units").textContent = number(units);
    get("purchase-empty").classList.toggle("hidden", matches.length > 0);
    const pageCount = Math.max(1, Math.ceil(matches.length / tablePageSize));
    purchasePage = Math.min(purchasePage, pageCount);
    const start = (purchasePage - 1) * tablePageSize;
    get("purchase-table").innerHTML = matches.slice(start, start + tablePageSize).map((entry) => `
      <tr><td><button class="row-action" data-edit-purchase="${entry._sheetRow || ""}">Edit</button></td><td>${dateLabel(entry.date)}</td><td><div class="item-name"><strong>${escapeHtml(entry.item)}</strong><small>${escapeHtml(entry.category)}</small></div></td><td>${escapeHtml(entry.vendor || "—")}</td><td class="stock-cell">${number(entry.quantity)}<small>units</small></td><td>${money(entry.unitCost)}</td><td class="stock-cell">${money(entry.cost)}</td></tr>`).join("");
    renderPagination("purchase-pagination", matches.length, purchasePage, (page) => {
      purchasePage = page;
      renderPurchases();
    });
  }

  function renderPayoutLog() {
    const query = get("payout-search").value.trim().toLowerCase();
    const payouts = newestFirst(state.payouts);
    const matches = payouts.filter((entry) =>
      [entry.date, dateLabel(entry.date), entry.platform, entry.amount, entry.status, entry.reference, entry.notes]
        .join(" ").toLowerCase().includes(query));
    const pending = payouts.filter((entry) => /pending|awaiting/i.test(entry.status))
      .reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
    get("payout-log-total").textContent = money(sumAmount(payouts, "amount"));
    get("payout-log-count").textContent = number(payouts.length);
    get("payout-log-pending").textContent = money(pending);
    get("payout-log-result-count").textContent = `${number(matches.length)} ${matches.length === 1 ? "payout" : "payouts"}`;
    get("payout-log-empty").classList.toggle("hidden", matches.length > 0);
    const pageCount = Math.max(1, Math.ceil(matches.length / tablePageSize));
    payoutPage = Math.min(payoutPage, pageCount);
    const start = (payoutPage - 1) * tablePageSize;
    get("payout-log-table").innerHTML = matches.slice(start, start + tablePageSize).map((entry) => {
      const isPending = /pending|awaiting/i.test(entry.status);
      return `<tr><td><button class="row-action" data-edit-payout="${entry._sheetRow || ""}">Edit</button></td><td>${dateLabel(entry.date)}</td><td>${escapeHtml(entry.platform || "—")}</td><td class="stock-cell">${money(entry.amount)}</td><td><span class="status-pill ${isPending ? "low" : ""}">${escapeHtml(entry.status || "Recorded")}</span></td><td>${escapeHtml(entry.reference || "—")}</td><td>${escapeHtml(entry.notes || "—")}</td></tr>`;
    }).join("");
    renderPagination("payout-log-pagination", matches.length, payoutPage, (page) => {
      payoutPage = page;
      renderPayoutLog();
    });
  }

  function renderExpenseLog() {
    const query = get("expense-search").value.trim().toLowerCase();
    const expenses = newestFirst(state.expenses);
    const matches = expenses.filter((entry) =>
      [entry.date, dateLabel(entry.date), entry.category, entry.beneficiary, entry.description, entry.amount, entry.mode, entry.status, entry.notes]
        .join(" ").toLowerCase().includes(query));
    const pending = expenses.filter((entry) => /pending|awaiting/i.test(entry.status))
      .reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
    get("expense-log-total").textContent = money(sumAmount(expenses, "amount"));
    get("expense-log-count").textContent = number(expenses.length);
    get("expense-log-pending").textContent = money(pending);
    get("expense-log-result-count").textContent = `${number(matches.length)} ${matches.length === 1 ? "expense" : "expenses"}`;
    get("expense-log-empty").classList.toggle("hidden", matches.length > 0);
    const pageCount = Math.max(1, Math.ceil(matches.length / tablePageSize));
    expensePage = Math.min(expensePage, pageCount);
    const start = (expensePage - 1) * tablePageSize;
    get("expense-log-table").innerHTML = matches.slice(start, start + tablePageSize).map((entry) => {
      const isPending = /pending|awaiting/i.test(entry.status);
      return `<tr><td><button class="row-action" data-edit-expense="${entry._sheetRow || ""}">Edit</button></td><td>${dateLabel(entry.date)}</td><td>${escapeHtml(entry.category || "—")}</td><td>${escapeHtml(entry.beneficiary || "—")}</td><td>${escapeHtml(entry.description || "—")}</td><td class="stock-cell">${money(entry.amount)}</td><td>${escapeHtml(entry.mode || "—")}</td><td><span class="status-pill ${isPending ? "low" : ""}">${escapeHtml(entry.status || "Recorded")}</span></td><td>${escapeHtml(entry.notes || "—")}</td></tr>`;
    }).join("");
    renderPagination("expense-log-pagination", matches.length, expensePage, (page) => {
      expensePage = page;
      renderExpenseLog();
    });
  }

  function renderPagination(containerId, totalItems, currentPage, setPage) {
    const container = get(containerId);
    if (totalItems === 0) {
      container.innerHTML = "";
      container.classList.add("hidden");
      return;
    }
    const pageCount = Math.ceil(totalItems / tablePageSize);
    const firstItem = (currentPage - 1) * tablePageSize + 1;
    const lastItem = Math.min(currentPage * tablePageSize, totalItems);
    container.classList.remove("hidden");
    container.innerHTML = `
      <span class="pagination-summary">Showing ${number(firstItem)}–${number(lastItem)} of ${number(totalItems)}</span>
      <div class="pagination-controls">
        <button class="pagination-button" type="button" data-page="${currentPage - 1}" ${currentPage <= 1 ? "disabled" : ""} aria-label="Previous page">‹</button>
        <span class="pagination-page">Page ${number(currentPage)} of ${number(pageCount)}</span>
        <button class="pagination-button" type="button" data-page="${currentPage + 1}" ${currentPage >= pageCount ? "disabled" : ""} aria-label="Next page">›</button>
      </div>`;
    container.onclick = (event) => {
      const button = event.target.closest("[data-page]");
      if (!button || button.disabled) return;
      setPage(Number(button.dataset.page));
    };
  }

  function zipStored(files) {
    const encoder = new TextEncoder();
    const crcTable = Array.from({ length: 256 }, (_, index) => {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      return value >>> 0;
    });
    const checksum = (bytes) => {
      let value = 0xffffffff;
      bytes.forEach((byte) => { value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8); });
      return (value ^ 0xffffffff) >>> 0;
    };
    const write16 = (view, offset, value) => view.setUint16(offset, value, true);
    const write32 = (view, offset, value) => view.setUint32(offset, value, true);
    const localParts = [];
    const centralParts = [];
    let localOffset = 0;

    files.forEach(({ name, content }) => {
      const nameBytes = encoder.encode(name);
      const data = encoder.encode(content);
      const crc = checksum(data);
      const localHeader = new Uint8Array(30 + nameBytes.length);
      const localView = new DataView(localHeader.buffer);
      write32(localView, 0, 0x04034b50);
      write16(localView, 4, 20);
      write16(localView, 10, 33);
      write32(localView, 14, crc);
      write32(localView, 18, data.length);
      write32(localView, 22, data.length);
      write16(localView, 26, nameBytes.length);
      localHeader.set(nameBytes, 30);
      localParts.push(localHeader, data);

      const centralHeader = new Uint8Array(46 + nameBytes.length);
      const centralView = new DataView(centralHeader.buffer);
      write32(centralView, 0, 0x02014b50);
      write16(centralView, 4, 20);
      write16(centralView, 6, 20);
      write16(centralView, 12, 33);
      write32(centralView, 16, crc);
      write32(centralView, 20, data.length);
      write32(centralView, 24, data.length);
      write16(centralView, 28, nameBytes.length);
      write32(centralView, 42, localOffset);
      centralHeader.set(nameBytes, 46);
      centralParts.push(centralHeader);
      localOffset += localHeader.length + data.length;
    });

    const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    write32(endView, 0, 0x06054b50);
    write16(endView, 8, files.length);
    write16(endView, 10, files.length);
    write32(endView, 12, centralSize);
    write32(endView, 16, localOffset);
    return new Blob([...localParts, ...centralParts, end], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }

  function createExcelWorkbook(sheetName, rows, currencyColumns = []) {
    const xmlEscape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"
    })[character]);
    const columnName = (index) => {
      let name = "";
      for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
        name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
      }
      return name;
    };
    const columnWidths = rows[0].map((_, column) => Math.min(42, Math.max(12, ...rows.map((row) => String(row[column] ?? "").length + 2))));
    const columnXml = columnWidths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("");
    const rowXml = rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, column) => {
      const reference = `${columnName(column)}${rowIndex + 1}`;
      if (typeof value === "number" && Number.isFinite(value)) {
        const style = rowIndex > 0 && currencyColumns.includes(column) ? ' s="2"' : "";
        return `<c r="${reference}"${style}><v>${value}</v></c>`;
      }
      const style = rowIndex === 0 ? ' s="1"' : "";
      return `<c r="${reference}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
    }).join("")}</row>`).join("");
    const lastColumn = columnName(rows[0].length - 1);
    const lastRow = rows.length;
    const files = [
      { name: "[Content_Types].xml", content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
      { name: "_rels/.rels", content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: "xl/workbook.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
      { name: "xl/_rels/workbook.xml.rels", content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
      { name: "xl/styles.xml", content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="₹#,##0.00"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF315E4C"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>' },
      { name: "xl/worksheets/sheet1.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews><cols>${columnXml}</cols><sheetData>${rowXml}</sheetData><autoFilter ref="A1:${lastColumn}${lastRow}"/></worksheet>` }
    ];
    return zipStored(files);
  }

  function downloadExcel(filename, sheetName, rows, currencyColumns = []) {
    const url = URL.createObjectURL(createExcelWorkbook(sheetName, rows, currencyColumns));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadInventoryExcel() {
    const items = filteredInventory();
    downloadExcel("inventory.xlsx", "Inventory", [
      ["Item", "Category", "Sub-category", "Brand / Supplier", "On hand", "Unit", "Status"],
      ...items.map((item) => [item.name, item.category, item.subcategory, item.company, Number(item.stock), item.unit, statusFor(item.stock)[0]])
    ]);
  }

  function downloadPurchasesExcel() {
    const purchases = filteredPurchases();
    downloadExcel("purchases.xlsx", "Purchases", [
      ["Date", "Item", "Category", "Vendor", "Company", "Quantity", "Unit cost (INR)", "Total (INR)"],
      ...purchases.map((entry) => [entry.date, entry.item, entry.category, entry.vendor, entry.company, Number(entry.quantity), Math.round(Number(entry.unitCost) * 100) / 100, Math.round(Number(entry.cost) * 100) / 100])
    ], [6, 7]);
  }

  function renderPayoutReport() {
    const monthly = new Map();
    const getMonth = (date) => {
      const match = String(date || "").match(/^(\d{4})-(\d{2})-/);
      return match ? `${match[1]}-${match[2]}` : "";
    };
    const getTotals = (month) => {
      if (!monthly.has(month)) monthly.set(month, { Swiggy: 0, Zomato: 0, Magicpin: 0, Ownly: 0, revenue: 0, purchases: 0, operatingExpenses: 0 });
      return monthly.get(month);
    };
    state.payouts.forEach((entry) => {
      const month = getMonth(entry.date);
      if (!month) return;
      const totals = getTotals(month);
      const amount = Number(entry.amount) || 0;
      totals.revenue += amount;
      const platform = Object.keys(totals).find((name) => name.toLowerCase() === String(entry.platform || "").toLowerCase());
      if (platform) totals[platform] += amount;
    });
    state.purchases.forEach((entry) => {
      const month = getMonth(entry.date);
      if (month) getTotals(month).purchases += Number(entry.cost) || 0;
    });
    state.expenses.forEach((entry) => {
      const month = getMonth(entry.date);
      if (month) getTotals(month).operatingExpenses += Number(entry.amount) || 0;
    });
    const monthKeys = [...monthly.keys()].sort();
    if (monthKeys.length) {
      const cursor = new Date(`${monthKeys[0]}-01T00:00:00`);
      const lastMonth = monthKeys[monthKeys.length - 1];
      while (`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}` <= lastMonth) {
        getTotals(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`);
        cursor.setMonth(cursor.getMonth() + 1);
      }
    }
    const months = [...monthly.entries()].sort(([a], [b]) => a.localeCompare(b));
    const totals = { Swiggy: 0, Zomato: 0, Magicpin: 0, Ownly: 0, revenue: 0, purchases: 0, operatingExpenses: 0 };
    months.forEach(([, month]) => Object.keys(totals).forEach((key) => { totals[key] += month[key]; }));
    const totalExpenses = totals.purchases + totals.operatingExpenses;
    const netProfit = totals.revenue - totalExpenses;
    const margin = (revenue, profit) => revenue ? profit / revenue : 0;
    const monthLabel = (month) => new Intl.DateTimeFormat("en-IN", { month: "short", year: "numeric" })
      .format(new Date(`${month}-01T00:00:00`));
    const valueCells = (month) => {
      const expenses = month.purchases + month.operatingExpenses;
      const profit = month.revenue - expenses;
      return [
        month.Swiggy, month.Zomato, month.Magicpin, month.Ownly, month.revenue,
        month.purchases, month.operatingExpenses, expenses, profit, margin(month.revenue, profit)
      ];
    };
    const reportRows = months.map(([month, values]) => ({ month: monthLabel(month), cells: valueCells(values) }));
    const totalCells = valueCells(totals);
    get("monthly-report-revenue").textContent = money(totals.revenue);
    get("monthly-report-purchases").textContent = money(totals.purchases);
    get("monthly-report-operating-expenses").textContent = money(totals.operatingExpenses);
    get("monthly-report-total-expenses").textContent = money(totalExpenses);
    get("monthly-report-net-profit").textContent = money(netProfit);
    get("payout-report-empty").classList.toggle("hidden", months.length > 0);
    get("export-payout-report").disabled = months.length === 0;
    const formatCells = (cells) => cells.map((value, index) => `<td class="align-right" data-value="${value}">${index === 9 ? `${(value * 100).toFixed(1)}%` : money(value)}</td>`).join("");
    get("payout-report-months").innerHTML = reportRows.map((row) => `
      <tr><td>${row.month}</td>${formatCells(row.cells)}</tr>`).join("")
      + (months.length ? `<tr class="report-total-row"><td>Total</td>${formatCells(totalCells)}</tr>` : "");
  }

  function downloadPayoutReport() {
    const totalRow = get("payout-report-months").querySelector(".report-total-row");
    if (!totalRow) return;
    const csvCell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const csvAmount = (value) => (Number(value) || 0).toFixed(2);
    const rows = [
      ["Monthly Payouts Summary"],
      ["Total revenue (INR)", csvAmount(sumAmount(state.payouts, "amount"))],
      ["Total purchases (INR)", csvAmount(sumAmount(state.purchases, "cost"))],
      ["Operating expenses (INR)", csvAmount(totalExpenses())],
      ["Total expenses (INR)", csvAmount(sumAmount(state.purchases, "cost") + totalExpenses())],
      ["Net profit / (loss) (INR)", csvAmount(sumAmount(state.payouts, "amount") - sumAmount(state.purchases, "cost") - totalExpenses())],
      [],
      ["Month", "Swiggy", "Zomato", "Magicpin", "Ownly", "Total Credit", "Purchases & Inward Log", "Employee & Other Expenses", "Total Expenses", "Net Profit / Loss", "Net Margin %"],
      ...[...get("payout-report-months").querySelectorAll("tr:not(.report-total-row)")].map((row) => [
        row.cells[0].textContent.trim(),
        ...[...row.cells].slice(1).map((cell, index) => index === 9
          ? `${(Number(cell.dataset.value) * 100).toFixed(1)}%`
          : csvAmount(cell.dataset.value))
      ]),
      [
        totalRow.cells[0].textContent.trim(),
        ...[...totalRow.cells].slice(1).map((cell, index) => index === 9
          ? `${(Number(cell.dataset.value) * 100).toFixed(1)}%`
          : csvAmount(cell.dataset.value))
      ]
    ];
    const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "monthly-payouts-summary.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function renderFinance() {
    const expenseTotal = totalExpenses();
    const margin = totalRevenue() ? netProfit() / totalRevenue() * 100 : 0;
    get("finance-revenue").textContent = money(totalRevenue());
    get("finance-purchases").textContent = money(totalPurchases());
    get("finance-expenses").textContent = money(expenseTotal);
    get("finance-profit").textContent = money(netProfit());
    get("finance-margin").textContent = `${margin.toFixed(1)}% net margin`;

    const platformEntries = Object.entries(state.financials.platforms);
    const platformTotal = platformEntries.reduce((sum, [, amount]) => sum + Number(amount), 0) || 1;
    const platformColors = { Swiggy: "#ef8e53", Zomato: "#d96b67", Magicpin: "#967ac2", Ownly: "#6e91a8" };
    get("finance-platforms").innerHTML = platformEntries.map(([name, amount]) => `
      <div class="finance-platform-row"><div class="platform-name"><i class="platform-dot" style="background:${platformColors[name] || "#719981"}"></i>${escapeHtml(name)}</div>
        <div class="platform-track"><div class="platform-bar" style="width:${Math.max(1, amount / platformTotal * 100)}%;background:${platformColors[name] || "#719981"}"></div></div>
        <strong class="platform-value">${money(amount)}</strong><span class="share-label">${(amount / platformTotal * 100).toFixed(0)}%</span></div>`).join("");
    const pending = state.payouts.filter((entry) => entry.status.toLowerCase() === "pending")
      .reduce((sum, entry) => sum + Number(entry.amount), 0);
    get("pending-payout-note").textContent = pending ? `Workbook revenue includes ${money(pending)} marked pending in the payout log.` : "All settlements in the payout log are marked credited.";

    const expenses = state.expenses.reduce((totals, entry) => {
      const key = /wage|salary|staff/i.test(entry.category) ? "Staff wages"
        : /utilit|bill/i.test(entry.category) ? "Utilities & bills" : "Other overhead";
      totals[key] = (totals[key] || 0) + Number(entry.amount);
      return totals;
    }, {});
    const expenseColors = ["#d4a77e", "#9eb5a4", "#c9b2d1"];
    const expenseEntries = Object.entries(expenses);
    get("expense-breakdown").innerHTML = expenseEntries.map(([name, amount], index) => `
      <div class="expense-row"><span class="expense-name">${name}</span><div class="expense-track"><div class="expense-bar" style="width:${expenseTotal ? amount / expenseTotal * 100 : 0}%;background:${expenseColors[index % expenseColors.length]}"></div></div><strong class="expense-amount">${money(amount)}</strong></div>`).join("")
      || '<div class="empty-inline">No operating expenses recorded yet.</div>';

    const transactions = [
      ...state.payouts.map((entry) => ({ date: entry.date, kind: "payout", detail: `${entry.platform} settlement`, status: entry.status, amount: Number(entry.amount) })),
      ...state.expenses.map((entry) => ({ date: entry.date, kind: "expense", detail: `${entry.category} · ${entry.beneficiary || entry.description}`, status: entry.status || "Recorded", amount: Number(entry.amount) }))
    ];
    const latestTransactions = newestFirst(transactions).slice(0, 12);
    get("finance-table").innerHTML = latestTransactions.map((entry) => `
      <tr><td>${dateLabel(entry.date)}</td><td><span class="transaction-type ${entry.kind === "expense" ? "expense" : ""}">${entry.kind === "payout" ? "↗ Inflow" : "↙ Expense"}</span></td><td>${escapeHtml(entry.detail)}</td><td>${escapeHtml(entry.status || "Recorded")}</td><td class="align-right stock-cell">${entry.kind === "expense" ? "−" : "+"}${money(entry.amount)}</td></tr>`).join("");
    renderPayoutReport();
  }

  function showPage(page) {
    document.querySelectorAll(".page-view").forEach((view) => view.classList.toggle("active", view.id === `page-${page}`));
    document.querySelectorAll(".nav-link").forEach((link) => link.classList.toggle("active", link.dataset.page === page));
    const labels = { dashboard: "Overview", inventory: "Inventory", movements: "Stock movements", purchases: "Purchases", payouts: "Online payouts", expenses: "Expenses", finance: "Profit & loss" };
    get("breadcrumb-current").textContent = labels[page];
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const field = (label, name, type, options = {}) => {
    const control = type === "select" && options.searchable !== false
      ? `<input id="field-${name}" name="${name}" type="search" list="field-${name}-options" autocomplete="off" placeholder="${escapeHtml(options.placeholder || "Type to search or choose...")}" ${options.required === false ? "" : "required"}><datalist id="field-${name}-options">${options.options.map(([value, text]) => `<option value="${escapeHtml(value)}" label="${escapeHtml(text)}"></option>`).join("")}</datalist>`
      : type === "select"
        ? `<select id="field-${name}" name="${name}" ${options.required === false ? "" : "required"}>${options.options.map(([value, text]) => `<option value="${escapeHtml(value)}">${escapeHtml(text)}</option>`).join("")}</select>`
      : `<input id="field-${name}" name="${name}" type="${type}" ${options.min !== undefined ? `min="${options.min}"` : ""} ${options.step ? `step="${options.step}"` : ""} ${options.placeholder ? `placeholder="${escapeHtml(options.placeholder)}"` : ""} ${options.required === false ? "" : "required"}>`;
    return `<div class="form-field ${options.full ? "full" : ""}"><label for="field-${name}">${label}</label>${control}</div>`;
  };

  const calculatedField = (label, id, value, help) => `<div class="form-field"><label for="${id}">${label}</label><input class="calculated-input" id="${id}" type="text" value="${escapeHtml(value)}" disabled><small class="field-help">${help}</small></div>`;

  function openForm({ eyebrow, title, submit, fields, initialValues = {}, onSubmit }) {
    get("dialog-eyebrow").textContent = eyebrow;
    get("dialog-title").textContent = title;
    get("dialog-submit").textContent = submit;
    get("dialog-fields").innerHTML = fields;
    get("dialog-error").classList.add("hidden");
    const dialog = get("app-dialog");
    const form = get("dialog-form");
    Object.entries(initialValues).forEach(([name, value]) => {
      const control = form.elements.namedItem(name);
      if (control) control.value = value ?? "";
    });
    form.onsubmit = async (event) => {
      event.preventDefault();
      for (const searchableField of form.querySelectorAll("input[list]")) {
        const options = [...searchableField.list.options];
        if (searchableField.required || searchableField.value) {
          if (!options.some((option) => option.value === searchableField.value)) {
            get("dialog-error").textContent = `Choose a listed option for ${form.querySelector(`label[for="${CSS.escape(searchableField.id)}"]`).textContent.toLowerCase()}.`;
            get("dialog-error").classList.remove("hidden");
            searchableField.focus();
            return;
          }
        }
      }
      const previous = clone(state);
      const values = Object.fromEntries(new FormData(form).entries());
      const error = onSubmit(values);
      if (error) {
        get("dialog-error").textContent = error;
        get("dialog-error").classList.remove("hidden");
        return;
      }
      const saveButton = get("dialog-submit");
      saveButton.disabled = true;
      saveButton.textContent = "Saving to Google Sheet…";
      try {
        await syncSpreadsheetChanges(previous, state);
        render();
        dialog.close();
        toast("Saved to your Google Sheet.");
      } catch (saveError) {
        state = document.querySelector(".app-shell").classList.contains("hidden") ? null : previous;
        if (state) render();
        get("dialog-error").textContent = `Could not save to Google Sheets: ${saveError.message} Your change was not kept.`;
        get("dialog-error").classList.remove("hidden");
      } finally {
        saveButton.disabled = false;
        saveButton.textContent = submit;
      }
    };
    dialog.showModal();
    const firstInput = form.querySelector("input, select");
    if (firstInput) firstInput.focus();
  }

  function editSelect(label, name, options, currentValue) {
    const allOptions = [...new Set([...options, currentValue].filter(Boolean))]
      .map((value) => [value, value]);
    return field(label, name, "select", { options: allOptions, searchable: true, required: Boolean(currentValue) });
  }

  function editRow(collection, row) {
    return state[collection].find((entry) => Number(entry._sheetRow) === Number(row));
  }

  function applyStockDeltas(deltas, date, notes) {
    for (const [itemName, delta] of deltas) {
      const item = state.inventory.find((candidate) => candidate.name === itemName);
      if (!item) return `The inventory item "${itemName}" no longer exists.`;
      if (Number(item.stock) + delta < 0) {
        return `This change would take ${itemName} below zero stock. Reduce the quantity or record a stock-in first.`;
      }
    }
    for (const [itemName, delta] of deltas) {
      if (!delta) continue;
      const item = state.inventory.find((candidate) => candidate.name === itemName);
      item.stock = Number(item.stock) + delta;
      state.movements.push({
        date: date || today(), item: itemName, type: delta < 0 ? "out" : "in",
        quantity: Math.abs(delta), staff: "Stockroom", notes
      });
      movementPage = 1;
    }
    return "";
  }

  function openEditRecord(collection, row) {
    const entry = editRow(collection, row);
    if (!entry) {
      toast("This row is no longer available. Refresh the sheet and try again.");
      return;
    }

    if (collection === "inventory") {
      const initialValues = {
        name: entry.name, category: entry.category, subcategory: entry.subcategory, unit: entry.unit,
        company: entry.company
      };
      openForm({
        eyebrow: "KITCHEN CATALOG", title: "Edit inventory item", submit: "Save changes",
        initialValues,
        fields: field("Item name", "name", "text", { full: true })
          + field("Category", "category", "text", { required: false })
          + field("Sub-category", "subcategory", "text", { required: false })
          + field("Purchase unit", "unit", "text")
          + calculatedField("On-hand stock (calculated)", "inventory-stock-calculated", `${number(entry.stock)} ${entry.unit}`, "Calculated from stock-in and stock-out records. Edit a stock movement to correct it.")
          + field("Brand / supplier", "company", "text", { required: false }),
        onSubmit: (values) => {
          const name = values.name.trim();
          if (!name || state.inventory.some((item) => item !== entry && item.name.toLowerCase() === name.toLowerCase())) return "Enter an item name that is not already in your catalog.";
          const oldName = entry.name;
          Object.assign(entry, {
            name, category: values.category.trim(), subcategory: values.subcategory.trim(),
            unit: values.unit.trim() || "Unit", company: values.company.trim()
          });
          if (oldName !== name) {
            state.purchases.forEach((purchase) => { if (purchase.item === oldName) purchase.item = name; });
            state.movements.forEach((movement) => { if (movement.item === oldName) movement.item = name; });
          }
          return "";
        }
      });
      return;
    }

    if (collection === "purchases") {
      const itemNames = state.inventory.map((item) => item.name);
      const initialValues = {
        date: entry.date, category: entry.category, item: entry.item, packets: entry.packets,
        cost: entry.cost, quantity: entry.quantity,
        expiry: entry.expiry, vendor: entry.vendor, company: entry.company
      };
      openForm({
        eyebrow: "PURCHASES & INWARD", title: "Edit purchase", submit: "Save changes",
        initialValues,
        fields: field("Purchase date", "date", "date", { required: false })
          + editSelect("Item", "item", itemNames, entry.item)
          + field("Category", "category", "text", { required: false })
          + field("Vendor", "vendor", "text", { required: false })
          + field("Brand / supplier", "company", "text", { required: false })
          + field("Units received", "quantity", "number", { min: 1, step: "1" })
          + field("Number of packs", "packets", "number", { min: 0, step: "1", required: false })
          + calculatedField("Unit cost (calculated)", "purchase-unit-cost-preview", money(unitCostFor(entry.cost, entry.quantity)), "Calculated automatically from total cost ÷ quantity.")
          + field("Total cost (₹)", "cost", "number", { min: 0, step: "0.01" })
          + field("Expiry / notes", "expiry", "text", { required: false, full: true }),
        onSubmit: (values) => {
          const quantity = Number(values.quantity);
          const packets = Number(values.packets) || 0;
          const cost = Number(values.cost);
          if (!Number.isInteger(quantity) || quantity <= 0 || !Number.isInteger(packets) || packets < 0
            || !Number.isFinite(cost) || cost < 0) {
            return "Enter whole-unit quantities and a non-negative total cost.";
          }
          const deltas = new Map();
          deltas.set(entry.item, (deltas.get(entry.item) || 0) - Number(entry.quantity));
          deltas.set(values.item, (deltas.get(values.item) || 0) + quantity);
          const correctionError = applyStockDeltas(deltas, today(), "Purchase edit correction");
          if (correctionError) return correctionError;
          state.financials.purchases += cost - Number(entry.cost);
          Object.assign(entry, {
            date: values.date, category: values.category.trim(), item: values.item, packets,
            cost, quantity, unitCost: unitCostFor(cost, quantity), expiry: values.expiry.trim(), vendor: values.vendor.trim(),
            company: values.company.trim()
          });
          return "";
        }
      });
      bindPurchaseUnitCostPreview();
      return;
    }

    if (collection === "movements") {
      const initialValues = { date: entry.date, item: entry.item, type: entry.type, quantity: entry.quantity, staff: entry.staff, notes: entry.notes };
      openForm({
        eyebrow: "STOCK MOVEMENT LOG", title: "Edit stock movement", submit: "Save changes",
        initialValues,
        fields: field("Date", "date", "date", { required: false })
          + editSelect("Item", "item", state.inventory.map((item) => item.name), entry.item)
          + field("Movement", "type", "select", { searchable: false, options: [["in", "Stock in (+)"], ["out", "Stock out (-)"]] })
          + field("Quantity", "quantity", "number", { min: 1, step: "1" })
          + field("Staff member", "staff", "text", { required: false })
          + field("Reason / reference", "notes", "text", { required: false, full: true }),
        onSubmit: (values) => {
          const quantity = Number(values.quantity);
          if (!Number.isInteger(quantity) || quantity <= 0) return "Quantity must be a whole number greater than zero.";
          const oldDelta = entry.type === "out" ? -Number(entry.quantity) : Number(entry.quantity);
          const newDelta = values.type === "out" ? -quantity : quantity;
          const deltas = new Map();
          deltas.set(entry.item, (deltas.get(entry.item) || 0) - oldDelta);
          deltas.set(values.item, (deltas.get(values.item) || 0) + newDelta);
          for (const [itemName, delta] of deltas) {
            const item = state.inventory.find((candidate) => candidate.name === itemName);
            if (!item) return `The inventory item "${itemName}" no longer exists.`;
            if (Number(item.stock) + delta < 0) return `This change would take ${itemName} below zero stock.`;
          }
          deltas.forEach((delta, itemName) => {
            const item = state.inventory.find((candidate) => candidate.name === itemName);
            item.stock = Number(item.stock) + delta;
          });
          Object.assign(entry, {
            date: values.date, item: values.item, type: values.type, quantity,
            staff: values.staff.trim(), notes: values.notes.trim()
          });
          return "";
        }
      });
      return;
    }

    if (collection === "payouts") {
      const initialValues = {
        date: entry.date, platform: entry.platform, amount: entry.amount,
        status: entry.status, reference: entry.reference, notes: entry.notes
      };
      openForm({
        eyebrow: "REVENUE", title: "Edit platform settlement", submit: "Save changes",
        initialValues,
        fields: field("Date", "date", "date", { required: false })
          + editSelect("Platform", "platform", ["Swiggy", "Zomato", "Magicpin", "Ownly"], entry.platform)
          + field("Amount (₹)", "amount", "number", { min: 0, step: "0.01" })
          + editSelect("Status", "status", ["Credited", "Processing", "Pending"], entry.status)
          + field("UTR / reference ID", "reference", "text", { required: false })
          + field("Notes", "notes", "text", { required: false, full: true }),
        onSubmit: (values) => {
          const amount = Number(values.amount);
          if (!Number.isFinite(amount) || amount < 0) return "Enter a non-negative settlement amount.";
          state.financials.platforms[entry.platform] = Number(state.financials.platforms[entry.platform] || 0) - Number(entry.amount);
          state.financials.platforms[values.platform] = Number(state.financials.platforms[values.platform] || 0) + amount;
          state.financials.revenue += amount - Number(entry.amount);
          Object.assign(entry, {
            date: values.date, platform: values.platform, amount, status: values.status,
            reference: values.reference.trim(), notes: values.notes.trim()
          });
          return "";
        }
      });
      return;
    }

    if (collection === "expenses") {
      const initialValues = {
        date: entry.date, category: entry.category, beneficiary: entry.beneficiary,
        description: entry.description, amount: entry.amount, mode: entry.mode,
        status: entry.status, notes: entry.notes
      };
      openForm({
        eyebrow: "EMPLOYEE & OPERATING EXPENSES", title: "Edit expense", submit: "Save changes",
        initialValues,
        fields: field("Date", "date", "date", { required: false })
          + editSelect("Expense category", "category", ["Staff Wages", "Utilities", "Rent", "Kitchen Supplies", "Maintenance", "Packaging", "Marketing & Misc", "Delivery Charges", "Account Maintain Charges"], entry.category)
          + field("Paid to / beneficiary", "beneficiary", "text", { required: false })
          + field("Description / purpose", "description", "text", { required: false })
          + field("Amount (₹)", "amount", "number", { min: 0, step: "0.01" })
          + editSelect("Payment mode", "mode", ["UPI", "Bank Transfer", "Cash", "Card"], entry.mode)
          + editSelect("Payment status", "status", ["Paid", "Pending", "Scheduled", "Cancelled"], entry.status)
          + field("Reference / notes", "notes", "text", { required: false, full: true }),
        onSubmit: (values) => {
          const amount = Number(values.amount);
          if (!Number.isFinite(amount) || amount < 0) return "Enter a non-negative expense amount.";
          Object.assign(entry, {
            date: values.date, category: values.category, beneficiary: values.beneficiary.trim(),
            description: values.description.trim(), amount, mode: values.mode, status: values.status,
            notes: values.notes.trim()
          });
          return "";
        }
      });
    }
  }

  function bindPurchaseUnitCostPreview() {
    const quantityInput = get("field-quantity");
    const costInput = get("field-cost");
    const preview = get("purchase-unit-cost-preview");
    if (!quantityInput || !costInput || !preview) return;
    const updatePreview = () => {
      const quantity = Number(quantityInput.value);
      const cost = Number(costInput.value);
      preview.value = money(cost >= 0 ? unitCostFor(cost, quantity) : 0);
    };
    quantityInput.addEventListener("input", updatePreview);
    costInput.addEventListener("input", updatePreview);
    updatePreview();
  }

  function openPurchase() {
    const items = [...state.inventory].sort((a, b) => a.name.localeCompare(b.name));
    const itemOptions = items.map((item) => [item.name, `${item.name} (${item.unit})`]);
    if (!itemOptions.length) {
      toast("Add an inventory item before recording a purchase.");
      return;
    }
    openForm({
      eyebrow: "PURCHASES & INWARD", title: "Record a purchase", submit: "Add purchase",
      fields: field("Item", "item", "select", { options: itemOptions, full: true, searchable: true })
        + field("Purchase date", "date", "date", { required: false })
        + field("Vendor", "vendor", "text", { placeholder: "Vendor or store" })
        + field("Units received", "quantity", "number", { min: 1, step: "1" })
        + field("Number of packs", "packets", "number", { min: 0, step: "1", required: false })
        + field("Total cost (₹)", "cost", "number", { min: 0, step: "0.01" })
        + calculatedField("Unit cost (calculated)", "purchase-unit-cost-preview", money(0), "Calculated automatically from total cost ÷ quantity.")
        + field("Expiry / notes", "expiry", "text", { placeholder: "Optional", required: false, full: true }),
      onSubmit: (values) => {
        const item = state.inventory.find((entry) => entry.name === values.item);
        const quantity = Number(values.quantity);
        const cost = Number(values.cost);
        if (!item || !Number.isInteger(quantity) || quantity <= 0 || !Number.isFinite(cost) || cost < 0) return "Enter a valid item, whole-unit quantity, and non-negative cost.";
        const date = values.date || today();
        state.purchases.push({ date, category: item.category, item: item.name, packets: Number(values.packets) || 0, cost, quantity, unitCost: unitCostFor(cost, quantity), expiry: values.expiry.trim(), vendor: values.vendor.trim(), company: item.company || "" });
        purchasePage = 1;
        item.stock = Number(item.stock) + quantity;
        state.financials.purchases += cost;
        state.movements.push({ date, item: item.name, type: "in", quantity, staff: "Stockroom", notes: values.vendor.trim() ? `Purchase · ${values.vendor.trim()}` : "Purchase inward" });
        return "";
      }
    });
    bindPurchaseUnitCostPreview();
    get("field-date").value = today();
    get("field-date").max = today();
  }

  function openAdjustment(itemName = "") {
    const items = [...state.inventory].sort((a, b) => a.name.localeCompare(b.name));
    if (!items.length) {
      toast("Add an inventory item before adjusting stock.");
      return;
    }
    openForm({
      eyebrow: "STOCK MOVEMENT", title: "Adjust on-hand stock", submit: "Save movement",
      fields: field("Item", "item", "select", { options: items.map((item) => [item.name, item.name]), full: true, searchable: true })
        + field("Movement", "type", "select", { options: [["in", "Stock in (+)"], ["out", "Stock out (−)"]] })
        + field("Quantity", "quantity", "number", { min: 1, step: "1" })
        + field("Date", "date", "date")
        + field("Staff member", "staff", "text", { placeholder: "Name", required: false })
        + field("Reason / reference", "notes", "text", { placeholder: "Prep, spoilage, order...", required: false, full: true }),
      onSubmit: (values) => {
        const item = state.inventory.find((entry) => entry.name === values.item);
        const quantity = Number(values.quantity);
        if (!item || !Number.isInteger(quantity) || quantity <= 0) return "Choose an item and enter a whole-unit quantity greater than zero.";
        if (values.type === "out" && quantity > Number(item.stock)) return `Only ${number(item.stock)} ${item.unit} available. Stock cannot go below zero.`;
        item.stock = Number(item.stock) + (values.type === "in" ? quantity : -quantity);
        state.movements.push({ date: values.date || today(), item: item.name, type: values.type, quantity, staff: values.staff.trim() || "Stockroom", notes: values.notes.trim() });
        return "";
      }
    });
    if (itemName && items.some((item) => item.name === itemName)) get("field-item").value = itemName;
    get("field-date").value = today();
    get("field-date").max = today();
  }

  function openNewItem() {
    const categories = [...new Set(state.inventory.map((item) => item.category.trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
    const categoryOptions = (categories.length ? categories : ["Food", "Packaging"]).map((category) => [category, category]);
    const subcategoryOptions = (category) => [...new Set(state.inventory
      .filter((item) => item.category.trim() === category)
      .map((item) => item.subcategory.trim())
      .filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const subcategoryField = field("Sub-category", "subcategory", "select", { options: [], required: false, placeholder: "Search or choose a sub-category..." })
      + `<div class="form-field hidden" id="new-subcategory-field"><label for="field-new-subcategory">New sub-category</label><input id="field-new-subcategory" name="newSubcategory" type="text" placeholder="Enter a new sub-category"></div>`;
    openForm({
      eyebrow: "KITCHEN CATALOG", title: "Add inventory item", submit: "Add item",
      fields: field("Item name", "name", "text", { full: true, placeholder: "e.g. Fresh mozzarella" })
        + field("Category", "category", "select", { options: categoryOptions, placeholder: "Search or choose a category..." })
        + subcategoryField
        + field("Purchase unit", "unit", "text", { placeholder: "Packet, bottle, box..." })
        + field("Opening stock", "stock", "number", { min: 0, step: "1" })
        + field("Brand / supplier", "company", "text", { required: false }),
      onSubmit: (values) => {
        const name = values.name.trim();
        const stock = Number(values.stock);
        const subcategory = values.subcategory === "__new__" ? values.newSubcategory.trim() : values.subcategory.trim();
        if (!name || state.inventory.some((item) => item.name.toLowerCase() === name.toLowerCase())) return "Enter a name that is not already in your catalog.";
        if (!Number.isInteger(stock) || stock < 0) return "Opening stock must be a whole number of zero or more.";
        if (values.subcategory === "__new__" && !subcategory) return "Enter the new sub-category name.";
        const item = { name, category: values.category, subcategory, unit: values.unit.trim() || "Unit", stock, company: values.company.trim() };
        state.inventory.push(item);
        inventoryPage = 1;
        if (stock > 0) state.movements.push({ date: today(), item: name, type: "in", quantity: stock, staff: "Stockroom", notes: "Opening stock" });
        return "";
      }
    });
    const categorySelect = get("field-category");
    const subcategorySelect = get("field-subcategory");
    const subcategoryOptionsList = get("field-subcategory-options");
    const newSubcategoryField = get("new-subcategory-field");
    const newSubcategoryInput = get("field-new-subcategory");
    let selectedCategory = "";
    const updateSubcategories = () => {
      if (!categoryOptions.some(([category]) => category === categorySelect.value)
        || selectedCategory === categorySelect.value) return;
      selectedCategory = categorySelect.value;
      const options = subcategoryOptions(categorySelect.value);
      subcategorySelect.value = "";
      subcategoryOptionsList.innerHTML = `${options.map((subcategory) => `<option value="${escapeHtml(subcategory)}"></option>`).join("")}<option value="__new__" label="Add a new sub-category…"></option>`;
      newSubcategoryField.classList.add("hidden");
      newSubcategoryInput.required = false;
      newSubcategoryInput.value = "";
    };
    categorySelect.addEventListener("input", updateSubcategories);
    categorySelect.addEventListener("change", updateSubcategories);
    const updateNewSubcategoryVisibility = () => {
      const addingNewSubcategory = subcategorySelect.value === "__new__";
      newSubcategoryField.classList.toggle("hidden", !addingNewSubcategory);
      newSubcategoryInput.required = addingNewSubcategory;
      if (addingNewSubcategory) newSubcategoryInput.focus();
    };
    subcategorySelect.addEventListener("input", updateNewSubcategoryVisibility);
    subcategorySelect.addEventListener("change", updateNewSubcategoryVisibility);
    updateSubcategories();
  }

  function openPayout() {
    openForm({
      eyebrow: "REVENUE", title: "Add platform settlement", submit: "Add settlement",
      fields: field("Platform", "platform", "select", { options: [["Swiggy", "Swiggy"], ["Zomato", "Zomato"], ["Magicpin", "Magicpin"], ["Ownly", "Ownly"]] })
        + field("Amount (₹)", "amount", "number", { min: 0.01, step: "0.01" })
        + field("Date", "date", "date")
        + field("Status", "status", "select", { options: [["Credited", "Credited"], ["Processing", "Processing"], ["Pending", "Pending"]] })
        + field("UTR / reference ID", "reference", "text", { placeholder: "Optional", required: false })
        + field("Notes", "notes", "text", { placeholder: "Optional", required: false }),
      onSubmit: (values) => {
        const amount = Number(values.amount);
        if (!Number.isFinite(amount) || amount <= 0) return "Enter a settlement amount greater than zero.";
        const date = values.date || today();
        state.payouts.push({ date, platform: values.platform, amount, status: values.status, reference: values.reference.trim(), notes: values.notes.trim() });
        state.financials.platforms[values.platform] = Number(state.financials.platforms[values.platform] || 0) + amount;
        state.financials.revenue += amount;
        payoutPage = 1;
        return "";
      }
    });
    get("field-date").value = today();
  }

  function openExpense() {
    openForm({
      eyebrow: "OPERATING COSTS", title: "Add operating expense", submit: "Add expense",
      fields: field("Expense category", "category", "select", { options: [
        ["Staff Wages", "Staff Wages"],
        ["Utilities", "Utilities"],
        ["Rent", "Rent"],
        ["Kitchen Supplies", "Kitchen Supplies"],
        ["Maintenance", "Maintenance"],
        ["Packaging", "Packaging"],
        ["Marketing & Misc", "Marketing & Misc"],
        ["Delivery Charges", "Delivery Charges"],
        ["Account Maintain Charges", "Account Maintain Charges"]
      ] })
        + field("Amount (₹)", "amount", "number", { min: 0.01, step: "0.01" })
        + field("Date", "date", "date")
        + field("Paid to", "beneficiary", "text", { placeholder: "Name or supplier", required: false })
        + field("Description", "description", "text", { full: true, placeholder: "What was this for?" })
        + field("Payment mode", "mode", "select", { options: [["UPI", "UPI"], ["Bank Transfer", "Bank Transfer"], ["Cash", "Cash"], ["Card", "Card"]] })
        + field("Payment status", "status", "select", { options: [["Paid", "Paid"], ["Pending", "Pending"], ["Scheduled", "Scheduled"], ["Cancelled", "Cancelled"]] })
        + field("Reference ID / notes", "notes", "text", { placeholder: "Optional", required: false, full: true }),
      onSubmit: (values) => {
        const amount = Number(values.amount);
        if (!values.category.trim()) return "Enter an expense category.";
        if (!Number.isFinite(amount) || amount <= 0) return "Enter an expense amount greater than zero.";
        state.expenses.push({ date: values.date || today(), category: values.category.trim(), beneficiary: values.beneficiary.trim(), description: values.description.trim(), amount, mode: values.mode.trim(), status: values.status, notes: values.notes.trim() });
        expensePage = 1;
        return "";
      }
    });
    get("field-date").value = today();
    get("field-date").max = today();
  }

  async function refreshGoogleSheet() {
    const button = get("google-top-button");
    button.disabled = true;
    button.innerHTML = "↻ <span>Refreshing…</span>";
    try {
      const remote = await loadSpreadsheet();
      state = remote;
      render();
      updateConnectionUI(true);
      toast("Latest workbook data loaded.");
    } catch (error) {
      if (sessionExpiresAt) {
        if (/insufficient authentication scopes|access_token_scope_insufficient/i.test(error.message)) {
          showReauthorizationPrompt(error.message);
        } else {
          openGoogleSettings();
          showGoogleError(error.message);
        }
      } else {
        updateLoginError(error.message);
      }
    } finally {
      button.disabled = false;
      updateConnectionUI(!document.querySelector(".app-shell").classList.contains("hidden"));
    }
  }

  async function restoreGoogleSession() {
    const authError = new URLSearchParams(window.location.search).get("auth_error");
    if (authError) {
      updateLoginError(authError);
      window.history.replaceState({}, document.title, window.location.pathname);
    }
    try {
      const response = await fetch(apiUrl("auth/session"));
      if (!response.ok) throw new Error(`Session check returned HTTP ${response.status}.`);
      const session = await response.json();
      get("oauth-setup-note").classList.toggle("hidden", Boolean(session.configured));
      if (!session.authenticated) return;
      updateGoogleProfile(session);
      sessionExpiresAt = session.expiresAt || 0;
      if (hasSavedSheet) {
        try {
          const remote = await loadSpreadsheet();
          state = remote;
          render();
          updateConnectionUI(true);
          showLoginPage(false);
        } catch (error) {
          if (!sessionExpiresAt) {
            resetLoginFlow();
            updateLoginError(error.message);
            return;
          }
          showReauthorizationPrompt(error.message);
        }
        return;
      }
      if (!sessionExpiresAt) {
        resetLoginFlow();
        updateLoginError("The server did not return a valid one-day Google session. Sign in again.");
        return;
      }
      get("login-step-signin").classList.add("hidden");
      get("google-sheet-form").classList.remove("hidden");
    } catch (error) {
      updateLoginError(`Could not check your sign-in session: ${error.message}`);
    }
  }

  document.querySelectorAll(".nav-link").forEach((link) => link.addEventListener("click", () => showPage(link.dataset.page)));
  document.querySelectorAll("[data-open-page]").forEach((button) => button.addEventListener("click", () => showPage(button.dataset.openPage)));
  document.querySelectorAll("[data-open-purchase]").forEach((button) => button.addEventListener("click", openPurchase));
  document.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => {
    inventoryFilter = button.dataset.filter;
    inventoryPage = 1;
    document.querySelectorAll("[data-filter]").forEach((tab) => tab.classList.toggle("active", tab === button));
    renderInventory();
  }));
  get("inventory-search").addEventListener("input", () => {
    inventoryPage = 1;
    renderInventory();
  });
  get("purchase-search").addEventListener("input", () => {
    purchasePage = 1;
    renderPurchases();
  });
  get("movement-search").addEventListener("input", () => {
    movementPage = 1;
    renderMovements();
  });
  get("payout-search").addEventListener("input", () => {
    payoutPage = 1;
    renderPayoutLog();
  });
  get("expense-search").addEventListener("input", () => {
    expensePage = 1;
    renderExpenseLog();
  });
  get("download-inventory").addEventListener("click", downloadInventoryExcel);
  get("download-purchases").addEventListener("click", downloadPurchasesExcel);
  get("inventory-table").addEventListener("click", (event) => {
    const editButton = event.target.closest("[data-edit-inventory]");
    if (editButton) {
      openEditRecord("inventory", editButton.dataset.editInventory);
      return;
    }
    const adjustButton = event.target.closest("[data-adjust]");
    if (adjustButton) openAdjustment(adjustButton.dataset.adjust);
  });
  get("movement-table").addEventListener("click", (event) => {
    const button = event.target.closest("[data-edit-movement]");
    if (button) openEditRecord("movements", button.dataset.editMovement);
  });
  get("purchase-table").addEventListener("click", (event) => {
    const button = event.target.closest("[data-edit-purchase]");
    if (button) openEditRecord("purchases", button.dataset.editPurchase);
  });
  get("payout-log-table").addEventListener("click", (event) => {
    const button = event.target.closest("[data-edit-payout]");
    if (button) openEditRecord("payouts", button.dataset.editPayout);
  });
  get("expense-log-table").addEventListener("click", (event) => {
    const button = event.target.closest("[data-edit-expense]");
    if (button) openEditRecord("expenses", button.dataset.editExpense);
  });
  get("quick-add").addEventListener("click", openPurchase);
  get("theme-toggle").addEventListener("click", () => {
    const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_KEY, theme);
    updateThemeToggle(theme);
  });
  get("add-item-button").addEventListener("click", openNewItem);
  get("adjust-stock-button").addEventListener("click", () => openAdjustment());
  document.querySelectorAll("[data-open-adjustment]").forEach((button) => button.addEventListener("click", () => openAdjustment()));
  get("add-payout-button").addEventListener("click", openPayout);
  get("add-expense-button").addEventListener("click", openExpense);
  get("export-payout-report").addEventListener("click", downloadPayoutReport);
  get("dialog-close").addEventListener("click", () => get("app-dialog").close());
  get("dialog-cancel").addEventListener("click", () => get("app-dialog").close());
  get("app-dialog").addEventListener("click", (event) => {
    if (event.target === get("app-dialog")) get("app-dialog").close();
  });
  get("connect-google").addEventListener("click", openGoogleSettings);
  get("google-sheet-id").addEventListener("input", (event) => updateWorkbookDownloadLink(event.currentTarget.value));
  get("login-google-button").addEventListener("click", () => {
    get("login-error").classList.add("hidden");
    startGoogleLogin();
  });
  get("reauthorize-google-button").addEventListener("click", startGoogleLogin);
  get("google-sheet-form").addEventListener("submit", (event) => {
    event.preventDefault();
    connectGoogleSheet();
  });
  get("logout-button").addEventListener("click", endGoogleSession);
  get("google-top-button").addEventListener("click", () => {
    refreshGoogleSheet();
  });
  get("google-sign-in").addEventListener("click", startGoogleLogin);
  get("google-dialog-close").addEventListener("click", () => get("google-dialog").close());
  get("google-cancel").addEventListener("click", () => get("google-dialog").close());
  get("google-dialog").addEventListener("click", (event) => {
    if (event.target === get("google-dialog")) get("google-dialog").close();
  });
  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin
      || event.source !== googleLoginPopup
      || event.data?.type !== "stocknest-oauth") return;
    googleLoginPopup = null;
    if (event.data.error) {
      updateLoginError(event.data.error);
      return;
    }
    restoreGoogleSession();
  });
  get("google-settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const sheetId = spreadsheetIdFromInput(get("google-sheet-id").value);
    if (!/^[a-zA-Z0-9-_]+$/.test(sheetId)) {
      showGoogleError("Enter a valid Google Sheet link or spreadsheet ID.");
      return;
    }
    const button = get("google-settings-form").querySelector('[type="submit"]');
    const previousState = state;
    button.disabled = true;
    button.textContent = "Loading sheet…";
    const previousSheetId = googleSettings.sheetId;
    googleSettings = { ...googleSettings, sheetId };
    try {
      const remote = await loadSpreadsheet();
      state = remote;
      localStorage.setItem(GOOGLE_SETTINGS_KEY, JSON.stringify({ sheetId }));
      get("google-sheet-id").value = sheetId;
      updateWorkbookDownloadLink(sheetId);
      get("google-login-error").classList.add("hidden");
      render();
      updateConnectionUI(true);
      get("google-dialog").close();
      toast("Google Sheet connected.");
    } catch (error) {
      googleSettings = { ...googleSettings, sheetId: previousSheetId };
      state = previousState;
      if (/insufficient authentication scopes|access_token_scope_insufficient/i.test(error.message)) {
        showReauthorizationPrompt(error.message);
      } else {
        showGoogleError(error.message);
      }
    } finally {
      button.disabled = false;
      button.textContent = "Save sheet link";
    }
  });
  get("login-sheet-id").value = googleSettings.sheetId;
  updateThemeToggle(savedTheme);
  updateConnectionUI(false);
  showLoginPage(true);
  const authError = new URLSearchParams(window.location.search).get("auth_error");
  if (authError) {
    updateLoginError(authError);
    window.history.replaceState({}, "", window.location.pathname);
  }
  restoreGoogleSession();
})();
