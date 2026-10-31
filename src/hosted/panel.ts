import type { ProvisioningOptions } from "./provisioning.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Self-contained operator panel (Faz D, minimal scope per ADR-0005):
 * workspace list/create, membership grant/revoke, pilot token mint with
 * one-time display, and MCP connection info. Zero dependencies, inline
 * script/style (operator-facing, token-protected, no external assets).
 * Scope notes: usage counters and end-user login are later slices; the
 * operator token lives in this browser's sessionStorage only.
 */
export function panelHtml(config: { audience: string; issuer: string; hostedEnabledTools: number }): string {
  const audience = escapeHtml(config.audience);
  const issuer = escapeHtml(config.issuer);
  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Search Memory — Hosted Pilot Paneli</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 60rem; padding: 0 1rem; color: #1a1a2e; background: #f6f7fb; }
  h1 { font-size: 1.3rem; } h2 { font-size: 1.05rem; margin-top: 1.6rem; }
  table { border-collapse: collapse; width: 100%; background: #fff; }
  th, td { border: 1px solid #d9dce3; padding: 0.35rem 0.6rem; font-size: 0.85rem; text-align: left; }
  input, button { font: inherit; padding: 0.3rem 0.55rem; margin: 0.15rem 0; }
  button { background: #3b5bdb; color: #fff; border: 0; cursor: pointer; }
  button.danger { background: #c0392b; } button.secondary { background: #5f6b7a; }
  fieldset { border: 1px solid #d9dce3; background: #fff; margin: 0.6rem 0; }
  label { display: inline-block; min-width: 9rem; font-size: 0.85rem; }
  .tokenbox { background: #10233f; color: #9fe3a1; padding: 0.6rem; font-family: monospace; font-size: 0.75rem; word-break: break-all; white-space: pre-wrap; }
  .error { color: #c0392b; font-size: 0.85rem; }
  .hint { color: #5f6b7a; font-size: 0.8rem; }
  code { background: #e8eaf1; padding: 0.05rem 0.3rem; }
</style>
</head>
<body>
<h1>Search Memory — Hosted Pilot Paneli</h1>
<p class="hint">Operatör yüzeyi (Faz D, minimal kapsam). Hosted araç yüzeyi: ${config.hostedEnabledTools}/12 araç. Kullanım sayaçları sonraki dilimdedir.</p>
<div id="login">
  <h2>Operatör girişi</h2>
  <p class="hint">Admin token bu tarayıcının sessionStorage'ında tutulur; sekme kapanınca silinir.</p>
  <input id="token" type="password" placeholder="HOSTED_ADMIN_TOKEN" size="48">
  <button id="loginBtn">Giriş</button>
  <p id="loginError" class="error"></p>
</div>
<div id="app" hidden>
  <h2>MCP bağlantı bilgisi (davetli kullanıcıya verilecek)</h2>
  <table>
    <tr><th>Audience (MCP endpoint)</th><td><code id="cfgAudience"></code></td></tr>
    <tr><th>Issuer</th><td><code id="cfgIssuer"></code></td></tr>
    <tr><th>Kimlik</th><td>Pilot token'ları bu panel üretir (server-imzalı, ADR-0006)</td></tr>
  </table>
  <h2>Workspaces</h2>
  <button id="reloadBtn" class="secondary">Yenile</button>
  <table id="wsTable"><thead><tr><th>Workspace</th><th>Tenant</th><th>Üyelikler</th></tr></thead><tbody id="wsBody"></tbody></table>
  <fieldset><legend>Workspace oluştur</legend>
    <label>workspaceId</label><input id="newWs" placeholder="ws-pilot">
    <label>tenantId (opsiyonel)</label><input id="newTenant" placeholder="boşsa workspaceId">
    <button id="createWsBtn">Oluştur</button>
  </fieldset>
  <h2>Üyelik ver</h2>
  <fieldset>
    <label>principalId</label><input id="mPrincipal" placeholder="davetli-kullanici">
    <label>workspaceId</label><input id="mWorkspace" placeholder="ws-pilot">
    <button id="grantBtn">Üyelik ver</button>
  </fieldset>
  <h2>Üyelik iptal</h2>
  <fieldset>
    <label>principalId</label><input id="rPrincipal" placeholder="davetli-kullanici">
    <label>workspaceId</label><input id="rWorkspace" placeholder="ws-pilot">
    <button id="revokeBtn" class="danger">İptal et</button>
  </fieldset>
  <h2>Pilot token mint</h2>
  <fieldset>
    <label>principalId</label><input id="tPrincipal" placeholder="davetli-kullanici">
    <label>workspaceId</label><input id="tWorkspace" placeholder="ws-pilot">
    <label>geçerlilik (gün)</label><input id="tTtl" type="number" value="7" min="1" max="30">
    <button id="mintBtn">Token üret</button>
  </fieldset>
  <div id="tokenOut" hidden>
    <p class="hint">Token bir kez gösterilir — davetli kullanıcıya güvenli bir kanaldan iletin.</p>
    <div class="tokenbox" id="tokenValue"></div>
  </div>
  <h2>Kullanım <span class="hint" id="usageSince"></span></h2>
  <button id="usageBtn" class="secondary">Kullanımı yenile</button>
  <table id="usageTable"><thead><tr><th>Tenant</th><th>Workspace</th><th>Araç</th><th>Çağrı</th><th>Hata</th></tr></thead><tbody id="usageBody"></tbody></table>
  <p class="hint" id="usageTotals"></p>
  <p id="appError" class="error"></p>
</div>
<script>
"use strict";
// Safe JSON-in-script: escape U+003C so "</script>" cannot break out.
var jsonForScript = function (value) { return JSON.stringify(value).replaceAll("<", "\\\\u003c"); };
var AUDIENCE_PLACEHOLDER = jsonForScript("${audience}");
var ISSUER_PLACEHOLDER = jsonForScript("${issuer}");
var TOKEN_KEY = "smm-admin-token";
var api = {
  call: function (method, path, body) {
    var token = sessionStorage.getItem(TOKEN_KEY) || "";
    return fetch(path, {
      method: method,
      headers: { "authorization": "Bearer " + token, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(function (res) {
      return res.json().then(function (payload) {
        if (!res.ok) { var err = new Error(payload.error || ("HTTP " + res.status)); err.status = res.status; throw err; }
        return payload;
      });
    });
  },
};
function show(id) { document.getElementById(id).hidden = false; }
function fail(id, error) { document.getElementById(id).textContent = error.message || String(error); }
function cell(row, value) { var td = document.createElement("td"); td.textContent = value === null || value === undefined ? "" : String(value); row.appendChild(td); }
function loadWorkspaces() {
  return api.call("GET", "/admin/workspaces").then(function (data) {
    var body = document.getElementById("wsBody");
    body.textContent = "";
    data.workspaces.forEach(function (ws) {
      var row = document.createElement("tr");
      cell(row, ws.workspace_id); cell(row, ws.tenant_id);
      cell(row, ws.disabled_at ? "devre dışı" : "aktif");
      var memberships = data.memberships.filter(function (m) { return m.workspace_id === ws.workspace_id; });
      var mCell = document.createElement("td");
      memberships.forEach(function (m) {
        var line = document.createElement("div");
        line.textContent = m.principal_id + (m.revoked_at ? " (iptal)" : " (aktif)");
        mCell.appendChild(line);
      });
      row.appendChild(mCell);
      body.appendChild(row);
    });
  });
}
function enterApp() {
  document.getElementById("login").hidden = true;
  show("app");
  document.getElementById("cfgAudience").textContent = AUDIENCE_PLACEHOLDER;
  document.getElementById("cfgIssuer").textContent = ISSUER_PLACEHOLDER;
  loadWorkspaces().catch(function (e) { fail("appError", e); });
  loadUsage().catch(function (e) { fail("appError", e); });
}
function loadUsage() {
  return api.call("GET", "/admin/usage").then(function (data) {
    var body = document.getElementById("usageBody");
    body.textContent = "";
    data.scopes.forEach(function (s) {
      var row = document.createElement("tr");
      cell(row, s.tenantId); cell(row, s.workspaceId); cell(row, s.tool); cell(row, s.calls); cell(row, s.errors);
      body.appendChild(row);
    });
    if (data.scopes.length === 0) {
      var row = document.createElement("tr");
      cell(row, "—"); cell(row, "—"); cell(row, "henüz çağrı yok"); cell(row, ""); cell(row, "");
      body.appendChild(row);
    }
    document.getElementById("usageSince").textContent = "(saymaya başlama: " + data.since + ")";
    document.getElementById("usageTotals").textContent = "Toplam: " + data.totals.calls + " çağrı, " + data.totals.errors + " hata. Sayaçlar sunucu yeniden başlayınca sıfırlanır.";
  });
}document.getElementById("loginBtn").addEventListener("click", function () {
  sessionStorage.setItem(TOKEN_KEY, document.getElementById("token").value.trim());
  document.getElementById("loginError").textContent = "";
  enterApp();
  loadWorkspaces().catch(function (e) {
    sessionStorage.removeItem(TOKEN_KEY);
    document.getElementById("login").hidden = false;
    document.getElementById("app").hidden = true;
    fail("loginError", e);
  });
});
document.getElementById("reloadBtn").addEventListener("click", function () {
  loadWorkspaces().catch(function (e) { fail("appError", e); });
  loadUsage().catch(function (e) { fail("appError", e); });
});
document.getElementById("createWsBtn").addEventListener("click", function () {
  api.call("POST", "/admin/workspaces", { workspaceId: document.getElementById("newWs").value.trim(), tenantId: document.getElementById("newTenant").value.trim() || undefined })
    .then(function () { document.getElementById("newWs").value = ""; document.getElementById("newTenant").value = ""; return loadWorkspaces(); })
    .catch(function (e) { fail("appError", e); });
});
document.getElementById("grantBtn").addEventListener("click", function () {
  api.call("POST", "/admin/memberships", { principalId: document.getElementById("mPrincipal").value.trim(), workspaceId: document.getElementById("mWorkspace").value.trim() })
    .then(function () { document.getElementById("mPrincipal").value = ""; return loadWorkspaces(); })
    .catch(function (e) { fail("appError", e); });
});
document.getElementById("revokeBtn").addEventListener("click", function () {
  api.call("POST", "/admin/memberships/revoke", { principalId: document.getElementById("rPrincipal").value.trim(), workspaceId: document.getElementById("rWorkspace").value.trim() })
    .then(function () { document.getElementById("rPrincipal").value = ""; return loadWorkspaces(); })
    .catch(function (e) { fail("appError", e); });
});
document.getElementById("mintBtn").addEventListener("click", function () {
  api.call("POST", "/admin/tokens", {
    principalId: document.getElementById("tPrincipal").value.trim(),
    workspaceId: document.getElementById("tWorkspace").value.trim(),
    ttlDays: Number(document.getElementById("tTtl").value) || 7,
  }).then(function (payload) {
    document.getElementById("tokenValue").textContent = payload.token;
    show("tokenOut");
    return loadWorkspaces();
  }).catch(function (e) { fail("appError", e); });
});
enterApp();
</script>
</body>
</html>`;
}
