const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const qs = require("querystring");
const { HttpsProxyAgent } = require("https-proxy-agent");

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;
const ACCOUNTS_FILE = path.join(__dirname, "accounts.json");

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ==========================================
// DATA STRUCTURE & STATE
// ==========================================
let accounts = [];
const activeIntervals = {};

// Load accounts on startup
function loadAccounts() {
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      const data = fs.readFileSync(ACCOUNTS_FILE, "utf8");
      accounts = JSON.parse(data);
      // Ensure logs and pairingInProgress fields exist in memory
      accounts.forEach(acc => {
        acc.logs = acc.logs || [];
        acc.pairingInProgress = false;
        acc.isRefreshing = false;
        acc.env = acc.env || "prod";
      });
      console.log(`Loaded ${accounts.length} accounts from ${ACCOUNTS_FILE}`);
    } else {
      console.log("No accounts.json found, starting with empty accounts list.");
      accounts = [];
    }
  } catch (err) {
    console.error("Error loading accounts:", err);
    accounts = [];
  }
}

// Save accounts to disk
function saveAccounts() {
  try {
    // We don't need to persist logs and temporary flags to disk
    const dataToSave = accounts.map(({ id, name, env, access_token, refresh_token, whitelist, running }) => ({
      id,
      name,
      env: env || "prod",
      access_token,
      refresh_token,
      whitelist,
      running
    }));
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(dataToSave, null, 2), "utf8");
  } catch (err) {
    console.error("Error saving accounts to disk:", err);
  }
}

const SETTINGS_FILE = path.join(__dirname, "settings.json");
let globalSettings = { scanInterval: 10, selfPingUrl: "xyz", proxyUrl: "" };

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = fs.readFileSync(SETTINGS_FILE, "utf8");
      globalSettings = JSON.parse(data);
      if (globalSettings.proxyUrl === undefined) {
        globalSettings.proxyUrl = "";
      }
      console.log("Loaded global settings:", globalSettings);
    } else {
      saveSettings();
    }
  } catch (err) {
    console.error("Error loading settings:", err);
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(globalSettings, null, 2), "utf8");
  } catch (err) {
    console.error("Error saving settings:", err);
  }
}

function addLog(account, message) {
  const logEntry = {
    timestamp: new Date().toLocaleTimeString(),
    text: message
  };
  account.logs = account.logs || [];
  account.logs.push(logEntry);
  if (account.logs.length > 15) {
    account.logs.shift();
  }
  // Emit to socket clients for real-time streaming
  io.emit("log", { accountId: account.id, log: logEntry });
}

// ==========================================
// API LOGIC FOR A SPECIFIC BOX
// ==========================================

function getHeaders(account, contentType = "application/json") {
  const isStage = account.env === "stage";
  const origin = isStage ? "https://web.vr.ctrp-stag.stgbpkastro.com" : "https://vrptv.ctrp.astro.com.my";
  const referer = isStage ? "https://web.vr.ctrp-stag.stgbpkastro.com/" : "https://vrptv.ctrp.astro.com.my/";

  return {
    accept: "application/json, text/plain, */*",
    authorization: `Bearer ${account.access_token}`,
    "content-type": contentType,
    origin: origin,
    referer: referer,
    "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/148.0.0.0 Safari/537.36",
  };
}

function getApiBase(account) {
  const isStage = account.env === "stage";
  return isStage ? "https://consumer-am.ctrp-stag.stgbpkastro.com" : "https://consumer-am.ctrp.astro.com.my";
}

function getAxiosConfig(account, contentType = "application/json", customTimeout = 15000) {
  const config = {
    headers: getHeaders(account, contentType),
    timeout: customTimeout,
  };
  if (globalSettings.proxyUrl && globalSettings.proxyUrl !== "xyz" && globalSettings.proxyUrl.trim() !== "") {
    try {
      config.httpsAgent = new HttpsProxyAgent(globalSettings.proxyUrl.trim());
      config.proxy = false; // Disable axios default proxy logic when explicit agent is set
    } catch (e) {
      console.error("Invalid proxy URL:", e.message);
    }
  }
  return config;
}

async function refreshAccessToken(account) {
  if (account.isRefreshing) {
    addLog(account, "⏳ Token refresh already running...");
    return false;
  }

  try {
    account.isRefreshing = true;
    addLog(account, "🔄 Refreshing access token...");

    const response = await axios.post(
      `${getApiBase(account)}/v1/auth/token`,
      qs.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:refresh_token",
        refresh_token: account.refresh_token,
      }),
      getAxiosConfig(account, "application/x-www-form-urlencoded", 15000)
    );

    const data = response.data || {};

    if (!data.access_token) {
      addLog(account, "❌ No access token received during refresh");
      return false;
    }

    account.access_token = data.access_token;
    if (data.refresh_token) {
      account.refresh_token = data.refresh_token;
    }

    addLog(account, "✅ Access token refreshed and saved to disk");
    saveAccounts();
    io.emit("accounts_update", getSanitizedAccounts());
    return true;
  } catch (err) {
    const errorMsg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    addLog(account, `❌ Failed to refresh token: ${errorMsg}`);
    
    addLog(account, "🛑 Invalid refresh token. Automatically stopping protection loop.");
    stopAccountLoop(account);
    account.running = false;
    saveAccounts();
    io.emit("accounts_update", getSanitizedAccounts());
    
    return false;
  } finally {
    account.isRefreshing = false;
  }
}

async function getDevicesList(account, retry = true) {
  try {
    const response = await axios.get(`${getApiBase(account)}/v1/devices?limit=100`, getAxiosConfig(account, "application/json", 10000));
    return response.data?.data || [];
  } catch (err) {
    const status = err.response?.status;
    if ((status === 401 || status === 403) && retry) {
      addLog(account, "🔑 Auth failed while fetching devices, attempting refresh...");
      const refreshed = await refreshAccessToken(account);
      if (refreshed) {
        return getDevicesList(account, false);
      }
    }
    throw err;
  }
}

async function deleteDevice(account, deviceId, retry = true) {
  try {
    const url = `${getApiBase(account)}/v1/devices/${deviceId}`;
    await axios.delete(url, {
      ...getAxiosConfig(account, "application/json", 10000),
      data: {},
    });
    addLog(account, `❌ Logged out unauthorized device: ${deviceId}`);
    return true;
  } catch (err) {
    const status = err.response?.status;
    if ((status === 401 || status === 403) && retry) {
      addLog(account, `🔑 Auth failed for deleting device ${deviceId}, refreshing token...`);
      const refreshed = await refreshAccessToken(account);
      if (refreshed) {
        return deleteDevice(account, deviceId, false);
      }
    }
    const errorMsg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    addLog(account, `⚠ Failed to logout device ${deviceId}: ${errorMsg}`);
    return false;
  }
}

async function checkDevices(account) {
  if (account.pairingInProgress) {
    addLog(account, "⏳ Device check skipped: TV Login pairing is currently in progress...");
    return;
  }

  try {
    addLog(account, "🔍 Checking device list...");
    const devices = await getDevicesList(account);

    if (!devices || !devices.length) {
      addLog(account, "ℹ No devices found in account session list");
      return;
    }

    const whitelist = account.whitelist || [];
    const tasks = [];

    for (const device of devices) {
      const deviceId = device.deviceId;
      if (!deviceId) continue;

      if (whitelist.includes(deviceId)) {
        addLog(account, `✅ Device authorized: ${deviceId} (${device.deviceName || "Unknown"})`);
        continue;
      }

      addLog(account, `🚨 Unauthorized device detected: ${deviceId} (${device.deviceName || "Unknown"})`);
      tasks.push(deleteDevice(account, deviceId));
    }

    if (tasks.length > 0) {
      await Promise.allSettled(tasks);
    }
    addLog(account, "✔ Device scan completed");
  } catch (err) {
    const errorMsg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    addLog(account, `❌ Error during checkDevices loop: ${errorMsg}`);
  }
}

// ==========================================
// LOOP MANAGEMENT
// ==========================================

function startAccountLoop(account) {
  if (activeIntervals[account.id]) {
    clearInterval(activeIntervals[account.id]);
  }

  addLog(account, `🚀 Protection loop started (interval: ${globalSettings.scanInterval}s)`);
  
  // First run immediately
  checkDevices(account);

  // Interval execution
  activeIntervals[account.id] = setInterval(() => {
    checkDevices(account);
  }, globalSettings.scanInterval * 1000);
}

function stopAccountLoop(account) {
  if (activeIntervals[account.id]) {
    clearInterval(activeIntervals[account.id]);
    delete activeIntervals[account.id];
    addLog(account, "⏹ Protection loop stopped");
  }
}

function getSanitizedAccounts() {
  return accounts.map(({ id, name, env, access_token, refresh_token, whitelist, running, logs }) => ({
    id,
    name,
    env: env || "prod",
    access_token,
    refresh_token,
    whitelist,
    running,
    logs
  }));
}

// Start active loops on boot
function initializeLoops() {
  accounts.forEach(account => {
    if (account.running) {
      startAccountLoop(account);
    }
  });
}

// ==========================================
// API ENDPOINTS
// ==========================================

// Get all accounts
app.get("/api/accounts", (req, res) => {
  res.json(getSanitizedAccounts());
});

// Add a new account box
app.post("/api/accounts/add", (req, res) => {
  const { name, env, access_token, refresh_token } = req.body;
  if (!name || !access_token || !refresh_token) {
    return res.status(400).json({ error: "Missing required fields: name, access_token, refresh_token" });
  }

  const newAccount = {
    id: "box_" + Date.now(),
    name,
    env: env === "stage" ? "stage" : "prod",
    access_token,
    refresh_token,
    whitelist: [],
    running: false,
    logs: [],
    pairingInProgress: false,
    isRefreshing: false
  };

  accounts.push(newAccount);
  saveAccounts();
  
  addLog(newAccount, `📦 Account box created successfully (${newAccount.env.toUpperCase()})`);
  io.emit("accounts_update", getSanitizedAccounts());
  res.json({ success: true, account: getSanitizedAccounts().find(a => a.id === newAccount.id) });
});

// Update whitelist for an account
app.post("/api/accounts/update-whitelist", (req, res) => {
  const { id, whitelist } = req.body;
  if (!id || !Array.isArray(whitelist)) {
    return res.status(400).json({ error: "Invalid parameters" });
  }

  const account = accounts.find(acc => acc.id === id);
  if (!account) {
    return res.status(404).json({ error: "Account not found" });
  }

  account.whitelist = whitelist;
  saveAccounts();
  addLog(account, `📋 Whitelist updated manually: [${whitelist.join(", ")}]`);
  io.emit("accounts_update", getSanitizedAccounts());
  res.json({ success: true, whitelist: account.whitelist });
});

// Toggle running status of an account
app.post("/api/accounts/toggle", (req, res) => {
  const { id } = req.body;
  const account = accounts.find(acc => acc.id === id);
  if (!account) {
    return res.status(404).json({ error: "Account not found" });
  }

  account.running = !account.running;
  saveAccounts();

  if (account.running) {
    startAccountLoop(account);
  } else {
    stopAccountLoop(account);
  }

  io.emit("accounts_update", getSanitizedAccounts());
  res.json({ success: true, running: account.running });
});

// Delete an account box
app.post("/api/accounts/delete", (req, res) => {
  const { id } = req.body;
  const accountIndex = accounts.findIndex(acc => acc.id === id);
  if (accountIndex === -1) {
    return res.status(404).json({ error: "Account not found" });
  }

  const account = accounts[accountIndex];
  stopAccountLoop(account);
  accounts.splice(accountIndex, 1);
  saveAccounts();

  io.emit("accounts_update", getSanitizedAccounts());
  res.json({ success: true });
});

// Manually update tokens for an account box
app.post("/api/accounts/update-tokens", (req, res) => {
  const { id, access_token, refresh_token } = req.body;
  if (!id || !access_token || !refresh_token) {
    return res.status(400).json({ error: "Missing tokens or account ID" });
  }

  const account = accounts.find(acc => acc.id === id);
  if (!account) {
    return res.status(404).json({ error: "Account not found" });
  }

  account.access_token = access_token;
  account.refresh_token = refresh_token;
  saveAccounts();
  addLog(account, "🔑 Tokens updated manually from GUI");
  io.emit("accounts_update", getSanitizedAccounts());
  res.json({ success: true });
});

// TV Pairing Flow Endpoint
app.post("/api/accounts/tv-login", async (req, res) => {
  const { id, userCode } = req.body;
  if (!id || !userCode) {
    return res.status(400).json({ error: "Missing parameters: id and userCode are required" });
  }

  const account = accounts.find(acc => acc.id === id);
  if (!account) {
    return res.status(404).json({ error: "Account not found" });
  }

  // 1. Set pairingInProgress to pause the active logout loop
  account.pairingInProgress = true;
  addLog(account, `📺 Initiating TV Login pairing with code: "${userCode}"...`);

  try {
    // 2. Snapshot current active device list
    addLog(account, "📸 Capturing baseline device list before validation...");
    let devicesBefore = [];
    try {
      devicesBefore = await getDevicesList(account);
    } catch (err) {
      addLog(account, "⚠️ Baseline check failed, but will proceed with pairing");
    }

    // 3. Request TV Pairing code validation with auth API
    addLog(account, "📡 Validating code with authorization servers...");
        const validateUrl = `${getApiBase(account)}/v1/auth/device/validate?user_code=${encodeURIComponent(userCode)}`;
    
    const validateRes = await axios.post(
      validateUrl,
      null, // content-length: 0 body
      getAxiosConfig(account, "application/x-www-form-urlencoded", 15000)
    );

    addLog(account, "🤝 Code validated. Waiting 7 seconds for device list synchronization...");
    
    // 4. Wait for 7 seconds to let session list update
    await new Promise(resolve => setTimeout(resolve, 7000));

    // 5. Fetch updated devices list
    addLog(account, "📸 Fetching updated device list after validation...");
    const devicesAfter = await getDevicesList(account);

    // 6. Find the newly registered device
    let pairedDevice = null;
    if (devicesAfter && devicesAfter.length > 0) {
      // Find a device ID in devicesAfter that is not present in devicesBefore
      pairedDevice = devicesAfter.find(afterDev => 
        !devicesBefore.some(beforeDev => beforeDev.deviceId === afterDev.deviceId)
      );
    }

    if (pairedDevice && pairedDevice.deviceId) {
      const newId = pairedDevice.deviceId;
      addLog(account, `💡 Detected new device: ${newId} (${pairedDevice.deviceName || "TV Device"})`);
      
      if (!account.whitelist.includes(newId)) {
        account.whitelist.push(newId);
        saveAccounts();
        addLog(account, `🎉 Successfully whitelisted new device ID: ${newId}`);
        io.emit("accounts_update", getSanitizedAccounts());
        res.json({ success: true, deviceId: newId, message: "Successfully paired and whitelisted" });
      } else {
        addLog(account, `ℹ Device ${newId} was already whitelisted`);
        res.json({ success: true, deviceId: newId, message: "Device was already whitelisted" });
      }
    } else {
      // Fallback: If we couldn't resolve the difference, try to extract from response data or log it
      const responseData = validateRes.data || {};
      addLog(account, `⚠️ Pairing completed but no new device was detected in session list. API Response: ${JSON.stringify(responseData)}`);
      
      // Check if response contains device details directly
      const fallbackDeviceId = responseData.deviceId || responseData.data?.deviceId;
      if (fallbackDeviceId) {
        addLog(account, `💡 Found device ID in response payload: ${fallbackDeviceId}`);
        if (!account.whitelist.includes(fallbackDeviceId)) {
          account.whitelist.push(fallbackDeviceId);
          saveAccounts();
          addLog(account, `🎉 Successfully whitelisted fallback device ID: ${fallbackDeviceId}`);
          io.emit("accounts_update", getSanitizedAccounts());
          return res.json({ success: true, deviceId: fallbackDeviceId, message: "Paired and whitelisted via response payload" });
        }
      }
      
      res.status(422).json({ 
        error: "TV validated successfully, but could not auto-detect the new Device ID. Please check the logs or add the ID manually if it was deleted." 
      });
    }
  } catch (err) {
    const errorMsg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    addLog(account, `❌ TV pairing validation failed: ${errorMsg}`);
    res.status(500).json({ error: `Pairing failed: ${errorMsg}` });
  } finally {
    // 7. Resume the active device logout loop
    account.pairingInProgress = false;
    addLog(account, "🔄 Resumed active protection loop");
  }
});

// GET global settings
app.get("/api/settings", (req, res) => {
  res.json(globalSettings);
});

// Update global settings
app.post("/api/settings/update", (req, res) => {
  const { scanInterval, proxyUrl } = req.body;
  const intervalVal = parseInt(scanInterval);
  if (isNaN(intervalVal) || intervalVal < 3) {
    return res.status(400).json({ error: "Scan interval must be a number of at least 3 seconds" });
  }

  globalSettings.scanInterval = intervalVal;
  if (typeof proxyUrl === "string") {
    globalSettings.proxyUrl = proxyUrl.trim();
  }
  saveSettings();

  // Restart active loops with new interval
  accounts.forEach(account => {
    if (account.running) {
      addLog(account, `🔄 Scan interval changed to ${intervalVal}s. Restarting loop.`);
      startAccountLoop(account);
    }
  });

  res.json({ success: true, settings: globalSettings });
});

// Keep-Alive Self-Ping Loop (prevent Render from spinning down)
setInterval(async () => {
  try {
    await axios.get("https://logoutautomation.onrender.com/api/settings", { timeout: 5000 });
    console.log("[Keep-Alive] Sent self-ping to: https://logoutautomation.onrender.com/api/settings");
  } catch (err) {
    console.warn(`[Keep-Alive] Self-ping failed: ${err.message}`);
  }
}, 10000);

// ==========================================
// START SERVER
// ==========================================
loadSettings();
loadAccounts();
initializeLoops();

server.listen(PORT, () => {
  console.log(`=================================================`);
  console.log(`🚀 Server listening on http://localhost:${PORT}`);
  console.log(`=================================================`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("Shutting down gracefully...");
  Object.values(activeIntervals).forEach(clearInterval);
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});
