const path = require("node:path");
const { createHash } = require("node:crypto");
require("dotenv").config({ path: path.resolve(__dirname, "../.env"), quiet: true });
const db = require("../src/config/database");
const { clientDiagnostics, inspectAccessTokenClient } = require("../src/services/googleCmsAuthService");
const { renewSavedGrant } = require("../src/services/googleContentIdService");
const { searchArtistAssets } = require("../src/services/assetCheckService");

function fingerprint(id) {
  return id ? createHash("sha256").update(id).digest("hex").slice(0, 12) : null;
}

async function main() {
  const args = process.argv.slice(2);
  const [action, id, artist] = args;
  if (args.length && (!/^[1-9]\d*$/.test(id) ||
      !(action === "--identify" && args.length === 2 || action === "--refresh" && [2, 3].includes(args.length)))) {
    throw new Error("Usage: npm run cms:oauth:check [-- --identify NETWORK_ID | --refresh NETWORK_ID [ARTIST]]");
  }
  const config = clientDiagnostics();
  console.log(JSON.stringify({ activeClient: fingerprint(config.active), configuredClients: config.configuredIds.map(fingerprint) }));
  const read = db.prepare(`SELECT id, name, cms_auth_status, cms_oauth_client_id, cms_token_expiry,
    LENGTH(TRIM(COALESCE(cms_refresh_token, ''))) > 0 AS has_refresh,
    INSTR(COALESCE(cms_auth_scopes, ''), 'youtubepartner-channel-audit') > 0 AS has_audit FROM networks`);
  if (args.length) {
    const row = read.all().find((network) => network.id === Number(id));
    if (!row) throw new Error("Unknown network ID.");
    if (action === "--identify") {
      const network = db.prepare("SELECT cms_access_token FROM networks WHERE id = ?").get(row.id);
      const client = row.cms_oauth_client_id || await inspectAccessTokenClient(network.cms_access_token);
      if (!client) throw new Error("Google could not identify the client for this legacy access token. Check the configuration used when the CMS was connected.");
      console.log(JSON.stringify({ network: row.id, clientId: client, fingerprint: fingerprint(client),
        source: row.cms_oauth_client_id ? "saved grant" : "Google access token info",
        configured: config.configuredIds.includes(client), matchesActive: config.active === client }));
      return;
    }
    if (!row.has_refresh || !["connected", "error"].includes(row.cms_auth_status)) {
      throw new Error("No saved CMS grant available for this network.");
    }
    await renewSavedGrant(row.id);
    console.log(JSON.stringify({ refreshedNetwork: row.id }));
    if (artist !== undefined) {
      const page = await searchArtistAssets({ networkId: row.id, artist, scope: "all", type: "" });
      console.log(JSON.stringify({ network: row.id, artist, assetsOnFirstPage: page.items.length, total: page.total }));
    }
  }
  for (const row of read.all()) {
    console.log(JSON.stringify({ network: row.id, name: row.name, status: row.cms_auth_status,
      savedRefreshToken: Boolean(row.has_refresh), boundClient: fingerprint(row.cms_oauth_client_id),
      bindingConfigured: row.cms_oauth_client_id ? config.configuredIds.includes(row.cms_oauth_client_id) : null,
      accessExpiresAt: row.cms_token_expiry, channelAuditScope: Boolean(row.has_audit) }));
  }
}

main().catch((error) => {
  // Axios errors can contain an Authorization header or the form submitted to Google.
  console.error(error.reason || error.code || "check_failed", error.message);
  process.exitCode = 1;
});
