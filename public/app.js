document.addEventListener("DOMContentLoaded", () => {
  const cardsGrid = document.getElementById("cards-grid");
  const modal = document.getElementById("add-account-modal");
  const btnOpenModal = document.getElementById("btn-open-add-modal");
  const btnCloseModal = document.getElementById("btn-close-add-modal");
  const btnCancelAdd = document.getElementById("btn-cancel-add");
  const btnSubmitAdd = document.getElementById("btn-submit-add");

  // Inputs in modal
  const accNameInput = document.getElementById("acc-name");
  const accEnvInput = document.getElementById("acc-env");
  const accAccessTokenInput = document.getElementById("acc-access-token");
  const accRefreshTokenInput = document.getElementById("acc-refresh-token");

  // Global settings
  const inputScanInterval = document.getElementById("setting-scan-interval");
  const inputSelfPingUrl = document.getElementById("setting-self-ping-url");
  const btnSaveSettings = document.getElementById("btn-save-settings");

  let accounts = [];

  // Initialize WebSockets
  const socket = io();

  // Fetch initial accounts list
  async function fetchAccounts() {
    try {
      const res = await fetch("/api/accounts");
      accounts = await res.json();
      renderAllCards();
    } catch (err) {
      console.error("Error fetching accounts:", err);
      cardsGrid.innerHTML = `
        <div style="grid-column: 1/-1; text-align: center; padding: 3rem; color: var(--danger-color);">
          <p>❌ Error connecting to backend API. Please make sure the server is running.</p>
        </div>
      `;
    }
  }

  // Fetch initial settings
  async function fetchSettings() {
    try {
      const res = await fetch("/api/settings");
      const settings = await res.json();
      if (settings) {
        if (settings.scanInterval) {
          inputScanInterval.value = settings.scanInterval;
        }
        if (settings.selfPingUrl) {
          inputSelfPingUrl.value = settings.selfPingUrl;
        }
      }
    } catch (err) {
      console.error("Error fetching settings:", err);
    }
  }

  // Save settings event listener
  btnSaveSettings.addEventListener("click", async () => {
    const scanInterval = parseInt(inputScanInterval.value);
    const selfPingUrl = inputSelfPingUrl.value.trim();
    if (isNaN(scanInterval) || scanInterval < 3) {
      alert("Please enter a scan interval of at least 3 seconds.");
      return;
    }
    if (!selfPingUrl) {
      alert("Please enter a valid Keep-Alive Ping URL or 'xyz' to disable.");
      return;
    }

    try {
      btnSaveSettings.disabled = true;
      btnSaveSettings.textContent = "Saving...";
      const res = await fetch("/api/settings/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scanInterval, selfPingUrl })
      });
      const data = await res.json();
      if (data.success) {
        alert("Global settings updated successfully.");
      } else {
        alert("Error updating settings: " + data.error);
      }
    } catch (err) {
      console.error(err);
      alert("Failed to update settings.");
    } finally {
      btnSaveSettings.disabled = false;
      btnSaveSettings.textContent = "Apply Settings";
    }
  });

  // Socket listeners
  socket.on("accounts_update", (updatedAccounts) => {
    accounts = updatedAccounts;
    renderAllCards();
  });

  socket.on("log", ({ accountId, log }) => {
    const account = accounts.find(a => a.id === accountId);
    if (account) {
      account.logs = account.logs || [];
      account.logs.push(log);
      if (account.logs.length > 15) {
        account.logs.shift();
      }
      appendLogToTerminal(accountId, log);
    }
  });

  // Tab elements
  const tabJsonBtn = document.getElementById("tab-json-btn");
  const tabManualBtn = document.getElementById("tab-manual-btn");
  const sectionJsonInput = document.getElementById("section-json-input");
  const sectionManualInput = document.getElementById("section-manual-input");
  const accJsonDataInput = document.getElementById("acc-json-data");

  let activeTab = "json"; // default

  tabJsonBtn.addEventListener("click", () => {
    activeTab = "json";
    tabJsonBtn.classList.add("active");
    tabManualBtn.classList.remove("active");
    sectionJsonInput.style.display = "flex";
    sectionManualInput.style.display = "none";
  });

  tabManualBtn.addEventListener("click", () => {
    activeTab = "manual";
    tabManualBtn.classList.add("active");
    tabJsonBtn.classList.remove("active");
    sectionJsonInput.style.display = "none";
    sectionManualInput.style.display = "flex";
  });

  // Modal actions
  btnOpenModal.addEventListener("click", () => {
    modal.classList.add("open");
  });

  const closeModal = () => {
    modal.classList.remove("open");
    accNameInput.value = "";
    accEnvInput.value = "prod";
    accAccessTokenInput.value = "";
    accRefreshTokenInput.value = "";
    accJsonDataInput.value = "";
    
    // Reset tabs
    activeTab = "json";
    tabJsonBtn.classList.add("active");
    tabManualBtn.classList.remove("active");
    sectionJsonInput.style.display = "flex";
    sectionManualInput.style.display = "none";
  };

  btnCloseModal.addEventListener("click", closeModal);
  btnCancelAdd.addEventListener("click", closeModal);

  btnSubmitAdd.addEventListener("click", async () => {
    const name = accNameInput.value.trim();
    const env = accEnvInput.value;
    if (!name) {
      alert("Please enter an account name.");
      return;
    }

    let access_token = "";
    let refresh_token = "";

    if (activeTab === "json") {
      const jsonRaw = accJsonDataInput.value.trim();
      if (!jsonRaw) {
        alert("Please paste the full token JSON.");
        return;
      }
      try {
        const tokenObj = JSON.parse(jsonRaw);
        access_token = tokenObj.access_token || tokenObj.accessToken;
        refresh_token = tokenObj.refresh_token || tokenObj.refreshToken;
        if (!access_token || !refresh_token) {
          alert("Could not find access_token and refresh_token inside the JSON object.");
          return;
        }
      } catch (err) {
        alert("Invalid JSON format. Please paste a valid JSON object.");
        return;
      }
    } else {
      access_token = accAccessTokenInput.value.trim();
      refresh_token = accRefreshTokenInput.value.trim();
      if (!access_token || !refresh_token) {
        alert("Please paste both access token and refresh token.");
        return;
      }
    }

    try {
      const res = await fetch("/api/accounts/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, env, access_token, refresh_token })
      });
      const data = await res.json();
      if (data.success) {
        closeModal();
        fetchAccounts();
      } else {
        alert("Error adding account: " + data.error);
      }
    } catch (err) {
      console.error(err);
      alert("Request failed");
    }
  });

  // Render a list of cards without destroying interactive states of text inputs
  function renderAllCards() {
    // Remove main loader if it exists
    const mainLoader = document.getElementById("main-loader");
    if (mainLoader) {
      mainLoader.remove();
    }

    if (accounts.length === 0) {
      cardsGrid.innerHTML = `
        <div style="grid-column: 1/-1; text-align: center; padding: 4rem; color: var(--text-secondary); background: var(--bg-secondary); border-radius: 16px; border: 1px dashed var(--border-color);">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom: 1rem; color: var(--text-secondary); opacity: 0.5;">
            <rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect>
            <rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect>
            <line x1="6" y1="6" x2="6.01" y2="6"></line>
            <line x1="6" y1="18" x2="6.01" y2="18"></line>
          </svg>
          <p style="font-weight: 600; margin-bottom: 0.25rem;">No Accounts Registered</p>
          <p style="font-size: 0.85rem; color: var(--text-secondary);">Click the "Add Account Box" button above to get started.</p>
        </div>
      `;
      return;
    }

    // Remove cards that are no longer present
    const existingCards = cardsGrid.querySelectorAll(".card");
    existingCards.forEach(card => {
      const cardId = card.getAttribute("data-id");
      if (!accounts.some(acc => acc.id === cardId)) {
        card.remove();
      }
    });

    // Add or update cards
    accounts.forEach(account => {
      let card = cardsGrid.querySelector(`.card[data-id="${account.id}"]`);

      if (!card) {
        // Create new card skeleton
        card = document.createElement("div");
        card.className = "card";
        card.setAttribute("data-id", account.id);
        card.innerHTML = `
          <div class="card-header">
            <div class="card-title-area">
              <div class="card-title">${escapeHTML(account.name)}</div>
              <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
                <div class="status-badge">
                  <span class="status-indicator-dot"></span>
                  <span class="status-text"></span>
                </div>
                <span class="env-badge"></span>
              </div>
            </div>
            <div class="card-actions">
              <button class="btn-toggle"></button>
              <button class="btn-danger btn-delete" style="padding: 0.5rem 0.75rem; border-radius: 6px; font-size: 0.8rem;">Delete</button>
            </div>
          </div>

          <!-- Manual Whitelist Section -->
          <div class="section-title">Whitelisted Device IDs</div>
          <div class="interactive-box">
            <div class="tags-container" id="tags-${account.id}"></div>
            <div class="input-group">
              <input type="text" class="input-field txt-whitelist" placeholder="Add device ID manually...">
              <button class="btn-primary btn-add-whitelist" style="padding: 0.5rem 1rem;">Add</button>
            </div>
          </div>

          <!-- TV Login Pairing Section -->
          <div class="section-title">TV Login Pairing</div>
          <div class="interactive-box">
            <div class="tv-login-group">
              <input type="text" class="input-field tv-input txt-pair-code" placeholder="PAIRCODE" maxlength="6">
              <button class="btn-primary btn-pair-tv" style="padding: 0.5rem 1rem; min-width: 90px;">
                <span class="pair-btn-text">Pair TV</span>
              </button>
            </div>
            <div class="pairing-status" id="pairing-status-${account.id}" style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 0.5rem; display: none;"></div>
          </div>

          <!-- Tokens Expandable Section -->
          <details class="tokens-details" id="details-${account.id}">
            <summary class="tokens-summary">
              <span>View / Edit Tokens</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="transition: transform 0.2s;"><polyline points="6 9 12 15 18 9"></polyline></svg>
            </summary>
            <div class="tokens-content">
              <div class="token-form-group">
                <label>Access Token</label>
                <textarea class="input-field token-textarea txt-access-token"></textarea>
              </div>
              <div class="token-form-group">
                <label>Refresh Token</label>
                <textarea class="input-field token-textarea txt-refresh-token"></textarea>
              </div>
              <button class="btn-primary btn-update-tokens" style="width: 100%; margin-top: 0.25rem; font-size: 0.8rem; padding: 0.5rem;">Update Tokens</button>
            </div>
          </details>

          <!-- Console Log Terminal -->
          <div class="section-title">
            <span>Console Logs (Last 15)</span>
            <span class="log-clear" style="font-size: 0.75rem; cursor: pointer; text-transform: none; color: var(--accent-color);">Clear View</span>
          </div>
          <div class="terminal" id="logs-${account.id}"></div>
        `;
        cardsGrid.appendChild(card);
        setupCardEvents(card, account.id);
      }

      // Update Dynamic Fields of the Card
      
      // 1. Status and toggling
      const statusBadge = card.querySelector(".status-badge");
      const statusText = card.querySelector(".status-text");
      const toggleBtn = card.querySelector(".btn-toggle");

      if (account.running) {
        statusBadge.className = "status-badge running";
        statusText.textContent = "Active Protection";
        toggleBtn.className = "btn-toggle stop";
        toggleBtn.textContent = "Stop Protection";
      } else {
        statusBadge.className = "status-badge stopped";
        statusText.textContent = "Inactive";
        toggleBtn.className = "btn-toggle start";
        toggleBtn.textContent = "Start Protection";
      }

      // Update env badge
      const envBadge = card.querySelector(".env-badge");
      if (account.env === "stage") {
        envBadge.className = "env-badge stage";
        envBadge.textContent = "Staging";
        envBadge.style.backgroundColor = "rgba(99, 102, 241, 0.12)";
        envBadge.style.color = "#818cf8";
        envBadge.style.border = "1px solid rgba(99, 102, 241, 0.2)";
      } else {
        envBadge.className = "env-badge prod";
        envBadge.textContent = "Production";
        envBadge.style.backgroundColor = "rgba(245, 158, 11, 0.12)";
        envBadge.style.color = "#fbbf24";
        envBadge.style.border = "1px solid rgba(245, 158, 11, 0.2)";
      }
      envBadge.style.fontSize = "0.75rem";
      envBadge.style.fontWeight = "600";
      envBadge.style.textTransform = "uppercase";
      envBadge.style.padding = "0.25rem 0.625rem";
      envBadge.style.borderRadius = "50px";
      envBadge.style.width = "fit-content";

      // 2. Whitelist tags
      const tagsContainer = card.querySelector(`#tags-${account.id}`);
      const currentTagsHTML = (account.whitelist || []).map(deviceId => `
        <span class="tag">
          ${escapeHTML(deviceId)}
          <button class="tag-remove" data-id="${escapeHTML(deviceId)}">&times;</button>
        </span>
      `).join("") || `<span class="empty-state-text">No devices whitelisted. Anyone logging in will be auto-logout.</span>`;
      
      if (tagsContainer.innerHTML !== currentTagsHTML) {
        tagsContainer.innerHTML = currentTagsHTML;
      }

      // 3. Tokens Textareas (only update if not currently focused to avoid messing up typing)
      const accessTokenTextarea = card.querySelector(".txt-access-token");
      const refreshTokenTextarea = card.querySelector(".txt-refresh-token");

      if (document.activeElement !== accessTokenTextarea) {
        accessTokenTextarea.value = account.access_token || "";
      }
      if (document.activeElement !== refreshTokenTextarea) {
        refreshTokenTextarea.value = account.refresh_token || "";
      }

      // 4. Logs Console (populate full history if changed/initially)
      const terminal = card.querySelector(`#logs-${account.id}`);
      if (terminal.childElementCount === 0 && account.logs && account.logs.length > 0) {
        terminal.innerHTML = "";
        account.logs.forEach(log => {
          terminal.appendChild(createLogLineElement(log));
        });
        terminal.scrollTop = terminal.scrollHeight;
      }

      // 5. TV Login Pairing Loader
      const pairButton = card.querySelector(".btn-pair-tv");
      const pairInput = card.querySelector(".txt-pair-code");
      const pairStatusDiv = card.querySelector(`#pairing-status-${account.id}`);

      if (account.pairingInProgress) {
        pairButton.disabled = true;
        pairInput.disabled = true;
        pairButton.innerHTML = `<span class="spinner"></span> Pairing...`;
      } else {
        pairButton.disabled = false;
        pairInput.disabled = false;
        pairButton.innerHTML = `<span class="pair-btn-text">Pair TV</span>`;
      }
    });
  }

  // Append a single log line (called on live socket events)
  function appendLogToTerminal(accountId, log) {
    const terminal = document.getElementById(`logs-${accountId}`);
    if (terminal) {
      // Keep only 15 children
      while (terminal.childElementCount >= 15) {
        terminal.removeChild(terminal.firstElementChild);
      }
      const lineEl = createLogLineElement(log);
      terminal.appendChild(lineEl);
      terminal.scrollTop = terminal.scrollHeight;
    }
  }

  function createLogLineElement(log) {
    const div = document.createElement("div");
    let typeClass = "log-text";
    
    if (log.text.includes("✅") || log.text.includes("🎉") || log.text.includes("success") || log.text.includes("Success")) {
      typeClass = "success";
    } else if (log.text.includes("🚨") || log.text.includes("❌") || log.text.includes("Failed")) {
      typeClass = "danger";
    } else if (log.text.includes("🔍") || log.text.includes("🔄") || log.text.includes("Checking")) {
      typeClass = "info";
    } else if (log.text.includes("⚠️") || log.text.includes("⏳") || log.text.includes("🔑")) {
      typeClass = "warn";
    }

    div.className = `terminal-line ${typeClass}`;
    div.innerHTML = `<span class="time">[${escapeHTML(log.timestamp)}]</span><span>${escapeHTML(log.text)}</span>`;
    return div;
  }

  // Setup event listeners inside each card box
  function setupCardEvents(card, accountId) {
    // Start / Stop Toggle
    card.querySelector(".btn-toggle").addEventListener("click", async () => {
      try {
        const res = await fetch("/api/accounts/toggle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: accountId })
        });
        const data = await res.json();
        if (!data.success) alert("Failed to toggle status");
      } catch (err) {
        console.error(err);
      }
    });

    // Delete Card Box
    card.querySelector(".btn-delete").addEventListener("click", async () => {
      if (!confirm("Are you sure you want to delete this account box?")) return;
      try {
        const res = await fetch("/api/accounts/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: accountId })
        });
        const data = await res.json();
        if (!data.success) alert("Failed to delete account");
      } catch (err) {
        console.error(err);
      }
    });

    // Whitelist Add (Button click or Enter key)
    const txtWhitelist = card.querySelector(".txt-whitelist");
    const btnAddWhitelist = card.querySelector(".btn-add-whitelist");

    const addWhitelistDevice = async () => {
      const deviceId = txtWhitelist.value.trim();
      if (!deviceId) return;

      const account = accounts.find(a => a.id === accountId);
      if (!account) return;

      const whitelist = [...(account.whitelist || [])];
      if (whitelist.includes(deviceId)) {
        alert("Device ID already in whitelist");
        txtWhitelist.value = "";
        return;
      }

      whitelist.push(deviceId);

      try {
        const res = await fetch("/api/accounts/update-whitelist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: accountId, whitelist })
        });
        const data = await res.json();
        if (data.success) {
          txtWhitelist.value = "";
        } else {
          alert("Error: " + data.error);
        }
      } catch (err) {
        console.error(err);
      }
    };

    btnAddWhitelist.addEventListener("click", addWhitelistDevice);
    txtWhitelist.addEventListener("keypress", (e) => {
      if (e.key === "Enter") addWhitelistDevice();
    });

    // Whitelist Remove (via Event delegation on tag-remove buttons)
    card.querySelector(`#tags-${accountId}`).addEventListener("click", async (e) => {
      if (e.target.classList.contains("tag-remove")) {
        const deviceIdToRemove = e.target.getAttribute("data-id");
        const account = accounts.find(a => a.id === accountId);
        if (!account) return;

        const whitelist = (account.whitelist || []).filter(id => id !== deviceIdToRemove);
        
        try {
          await fetch("/api/accounts/update-whitelist", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: accountId, whitelist })
          });
        } catch (err) {
          console.error(err);
        }
      }
    });

    // TV Login Pairing Trigger
    const txtPairCode = card.querySelector(".txt-pair-code");
    const btnPairTv = card.querySelector(".btn-pair-tv");
    const pairingStatusDiv = card.querySelector(`#pairing-status-${accountId}`);

    const pairTv = async () => {
      const userCode = txtPairCode.value.trim().toUpperCase();
      if (!userCode || userCode.length < 5) {
        alert("Please enter a valid 5 or 6 digit pairing code.");
        return;
      }

      pairingStatusDiv.style.display = "block";
      pairingStatusDiv.style.color = "var(--text-secondary)";
      pairingStatusDiv.textContent = "📡 Sending pairing request...";

      // Toggle local state immediately to trigger loaders
      const account = accounts.find(a => a.id === accountId);
      if (account) {
        account.pairingInProgress = true;
        renderAllCards();
      }

      try {
        const res = await fetch("/api/accounts/tv-login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: accountId, userCode })
        });
        const data = await res.json();

        if (res.ok && data.success) {
          pairingStatusDiv.style.color = "var(--success-color)";
          pairingStatusDiv.textContent = `✅ Successfully paired TV! Whitelisted device ID: ${data.deviceId}`;
          txtPairCode.value = "";
        } else {
          pairingStatusDiv.style.color = "var(--danger-color)";
          pairingStatusDiv.textContent = `❌ Pairing failed: ${data.error || "Unknown error"}`;
        }
      } catch (err) {
        console.error(err);
        pairingStatusDiv.style.color = "var(--danger-color)";
        pairingStatusDiv.textContent = "❌ Connection error during pairing.";
      } finally {
        if (account) {
          account.pairingInProgress = false;
          renderAllCards();
        }
      }
    };

    btnPairTv.addEventListener("click", pairTv);
    txtPairCode.addEventListener("keypress", (e) => {
      if (e.key === "Enter") pairTv();
    });

    // Update tokens manually
    card.querySelector(".btn-update-tokens").addEventListener("click", async () => {
      const access_token = card.querySelector(".txt-access-token").value.trim();
      const refresh_token = card.querySelector(".txt-refresh-token").value.trim();

      if (!access_token || !refresh_token) {
        alert("Please provide both tokens.");
        return;
      }

      try {
        const res = await fetch("/api/accounts/update-tokens", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: accountId, access_token, refresh_token })
        });
        const data = await res.json();
        if (data.success) {
          alert("Tokens updated successfully!");
        } else {
          alert("Failed to update tokens: " + data.error);
        }
      } catch (err) {
        console.error(err);
        alert("Error saving tokens");
      }
    });

    // Toggle Details SVG rotate
    const details = card.querySelector(`.tokens-details`);
    details.addEventListener("toggle", () => {
      const svg = details.querySelector("summary svg");
      if (details.open) {
        svg.style.transform = "rotate(180deg)";
        details.classList.add("open");
      } else {
        svg.style.transform = "rotate(0deg)";
        details.classList.remove("open");
      }
    });

    // Clear logs view inside browser console (leaves server intact)
    card.querySelector(".log-clear").addEventListener("click", () => {
      card.querySelector(`#logs-${accountId}`).innerHTML = "";
    });
  }

  // HTML escaping utility
  function escapeHTML(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // Load and start
  fetchAccounts();
  fetchSettings();
});
