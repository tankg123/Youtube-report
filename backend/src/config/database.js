const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");

const dataDir = path.join(__dirname, "../../data");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, "database.sqlite");

const db = new Database(dbPath);

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT,
    custom_url TEXT,
    thumbnail TEXT,
    view_count INTEGER DEFAULT 0,
    subscriber_count INTEGER DEFAULT 0,
    video_count INTEGER DEFAULT 0,
    country TEXT,
    published_at TEXT,
    latest_videos TEXT DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'active',
    status_error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sidebar_hidden_items (
    item_id TEXT PRIMARY KEY
  );
`);

const channelColumns = db.prepare("PRAGMA table_info(channels)").all();
const hasLatestVideos = channelColumns.some((column) => column.name === "latest_videos");
const hasChannelStatus = channelColumns.some((column) => column.name === "status");
const hasChannelStatusError = channelColumns.some((column) => column.name === "status_error");

if (!hasLatestVideos) {
  db.exec("ALTER TABLE channels ADD COLUMN latest_videos TEXT DEFAULT '[]'");
}

if (!hasChannelStatus) {
  db.exec("ALTER TABLE channels ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
}

if (!hasChannelStatusError) {
  db.exec("ALTER TABLE channels ADD COLUMN status_error TEXT");
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    first_name TEXT,
    last_name TEXT,
    email TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    status TEXT NOT NULL DEFAULT 'active',
    email_verified INTEGER NOT NULL DEFAULT 1,
    email_verified_at DATETIME,
    two_factor_enabled INTEGER NOT NULL DEFAULT 0,
    two_factor_secret TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

const userColumns = db.prepare("PRAGMA table_info(users)").all();
if (!userColumns.some((column) => column.name === "first_name")) {
  db.exec("ALTER TABLE users ADD COLUMN first_name TEXT");
}
if (!userColumns.some((column) => column.name === "last_name")) {
  db.exec("ALTER TABLE users ADD COLUMN last_name TEXT");
}
if (!userColumns.some((column) => column.name === "email_verified")) {
  db.exec("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1");
}
if (!userColumns.some((column) => column.name === "email_verified_at")) {
  db.exec("ALTER TABLE users ADD COLUMN email_verified_at DATETIME");
}
if (!userColumns.some((column) => column.name === "two_factor_enabled")) {
  db.exec("ALTER TABLE users ADD COLUMN two_factor_enabled INTEGER NOT NULL DEFAULT 0");
}
if (!userColumns.some((column) => column.name === "two_factor_secret")) {
  db.exec("ALTER TABLE users ADD COLUMN two_factor_secret TEXT");
}

db.exec(`
  CREATE TABLE IF NOT EXISTS email_verification_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    email TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at DATETIME NOT NULL,
    used_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

db.exec("CREATE INDEX IF NOT EXISTS idx_email_verification_user ON email_verification_codes(user_id, used_at, expires_at)");

db.exec(`
  CREATE TABLE IF NOT EXISTS password_reset_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    email TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at DATETIME NOT NULL,
    used_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

db.exec("CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_codes(user_id, used_at, expires_at)");

db.exec(`
  CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL UNIQUE,
    channel_id TEXT NOT NULL,
    channel_title TEXT,
    title TEXT NOT NULL,
    thumbnail TEXT,
    published_at TEXT,
    view_count_today INTEGER DEFAULT 0,
    view_count_yesterday INTEGER DEFAULT 0,
    view_growth INTEGER DEFAULT 0,
    last_checked_date TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS partners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    partner_name TEXT NOT NULL,
    display_name TEXT,
    email TEXT,
    contact_name TEXT,
    phone TEXT,
    counter_email TEXT,
    address TEXT,
    payment_method TEXT NOT NULL DEFAULT 'pingpongx',
    pingpongx TEXT,
    bank_name TEXT,
    bank_holder TEXT,
    account_number TEXT,
    swift_code TEXT,
    bank_branch TEXT,
    partner_status TEXT NOT NULL DEFAULT 'active',
    request_token TEXT,
    request_submitted_at DATETIME,
    contract_status TEXT NOT NULL DEFAULT 'not_created',
    contract_notes TEXT,
    contract_sent_at DATETIME,
    contract_signed_at DATETIME,
    contract_start_at DATETIME,
    contract_end_at DATETIME,
    contract_file_name TEXT,
    contract_file_data_url TEXT,
    internal_notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    address TEXT,
    representative_name TEXT,
    representative_position TEXT,
    hr_name TEXT,
    bank_name TEXT,
    account_number TEXT,
    tax_code TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS channel_revenues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT NOT NULL,
    network_id INTEGER,
    channel_id TEXT NOT NULL,
    revenue REAL NOT NULL DEFAULT 0,
    revenue_us REAL NOT NULL DEFAULT 0,
    revenue_br REAL NOT NULL DEFAULT 0,
    source_file TEXT,
    import_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS networks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    network_code TEXT,
    description TEXT,
    cms_auth_status TEXT NOT NULL DEFAULT 'not_connected',
    cms_auth_email TEXT,
    cms_auth_name TEXT,
    cms_auth_scopes TEXT,
    cms_access_token TEXT,
    cms_refresh_token TEXT,
    cms_token_expiry DATETIME,
    cms_authed_at DATETIME,
    cms_auth_error TEXT,
    cms_auth_generation TEXT,
    cms_oauth_client_id TEXT,
    cms_refresh_lock_id TEXT,
    cms_refresh_lock_until INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS report_imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    network_id INTEGER NOT NULL,
    month TEXT NOT NULL,
    file_name TEXT NOT NULL,
    channel_count INTEGER NOT NULL DEFAULT 0,
    total_revenue REAL NOT NULL DEFAULT 0,
    missing_channels TEXT NOT NULL DEFAULT '[]',
    imported_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS exchange_rates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT NOT NULL UNIQUE,
    usd_to_vnd REAL NOT NULL DEFAULT 0,
    usd_to_vnd_description TEXT,
    usd_to_gbp REAL NOT NULL DEFAULT 0,
    usd_to_gbp_description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS channel_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    partner_id INTEGER NOT NULL,
    group_name TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    fee_rate REAL NOT NULL DEFAULT 0,
    apply_revenue_tax INTEGER NOT NULL DEFAULT 0,
    description TEXT,
    tiers TEXT NOT NULL DEFAULT '[]',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (partner_id) REFERENCES partners(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS group_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    channel_id TEXT NOT NULL,
    custom_share REAL,
    custom_share_override INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(group_id, channel_id),
    FOREIGN KEY (group_id) REFERENCES channel_groups(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS channel_network_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    old_network_id INTEGER,
    new_network_id INTEGER NOT NULL,
    start_month TEXT NOT NULL,
    note TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (old_network_id) REFERENCES networks(id) ON DELETE SET NULL,
    FOREIGN KEY (new_network_id) REFERENCES networks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS collaborators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    display_name TEXT,
    theme_color TEXT NOT NULL DEFAULT '#137fec',
    status TEXT NOT NULL DEFAULT 'active',
    dashboard_enabled INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS managed_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT,
    custom_url TEXT,
    thumbnail TEXT,
    view_count INTEGER DEFAULT 0,
    subscriber_count INTEGER DEFAULT 0,
    video_count INTEGER DEFAULT 0,
    country TEXT,
    published_at TEXT,
    network_id INTEGER,
    partner_id INTEGER,
    collaborator_id INTEGER,
    revenue_sharing_id INTEGER,
    colab_revenue_sharing_id INTEGER,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    status_error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE SET NULL,
    FOREIGN KEY (partner_id) REFERENCES partners(id) ON DELETE SET NULL,
    FOREIGN KEY (collaborator_id) REFERENCES collaborators(id) ON DELETE SET NULL,
    FOREIGN KEY (revenue_sharing_id) REFERENCES revenue_sharings(id) ON DELETE SET NULL,
    FOREIGN KEY (colab_revenue_sharing_id) REFERENCES revenue_sharings(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS revenue_sharings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    share_rate REAL NOT NULL DEFAULT 0,
    theme_color TEXT NOT NULL DEFAULT '#137fec',
    status TEXT NOT NULL DEFAULT 'active',
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_group_permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    group_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, group_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (group_id) REFERENCES channel_groups(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS content_id_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label_id INTEGER,
    album_title TEXT NOT NULL,
    album_artist TEXT,
    album_upc TEXT,
    genre TEXT,
    label TEXT,
    release_date TEXT,
    ownership TEXT,
    match_policy TEXT,
    ddex_party_id TEXT,
    album_art_filename TEXT,
    track_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'created',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (label_id) REFERENCES content_id_labels(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS content_id_tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    track_number INTEGER NOT NULL DEFAULT 0,
    filename TEXT NOT NULL,
    isrc TEXT NOT NULL,
    song_title TEXT NOT NULL,
    artist TEXT,
    custom_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES content_id_products(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS content_id_labels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    display_name TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_content_id_labels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    label_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, label_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (label_id) REFERENCES content_id_labels(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS content_id_artists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    display_name TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS content_id_whitelists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    network_id INTEGER NOT NULL,
    content_owner_id TEXT,
    whitelist_id TEXT,
    channel_id TEXT NOT NULL,
    channel_title TEXT,
    custom_url TEXT,
    thumbnail_url TEXT,
    view_count INTEGER NOT NULL DEFAULT 0,
    subscriber_count INTEGER NOT NULL DEFAULT 0,
    video_count INTEGER NOT NULL DEFAULT 0,
    synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(network_id, channel_id),
    FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS content_id_track_artists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id INTEGER NOT NULL,
    artist_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(track_id, artist_id),
    FOREIGN KEY (track_id) REFERENCES content_id_tracks(id) ON DELETE CASCADE,
    FOREIGN KEY (artist_id) REFERENCES content_id_artists(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS expense_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_name TEXT NOT NULL,
    account_type TEXT NOT NULL DEFAULT 'bank',
    owner_type TEXT NOT NULL DEFAULT 'company',
    currency TEXT NOT NULL DEFAULT 'VND',
    bank_name TEXT,
    account_number TEXT,
    opening_balance REAL NOT NULL DEFAULT 0,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS expense_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS expense_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    category_id INTEGER,
    amount REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'VND',
    transaction_date TEXT NOT NULL,
    title TEXT NOT NULL,
    vendor TEXT,
    note TEXT,
    attachment_name TEXT,
    attachment_data_url TEXT,
    debt_status TEXT NOT NULL DEFAULT 'none',
    reimbursement_account_id INTEGER,
    reimbursed_at DATETIME,
    status TEXT NOT NULL DEFAULT 'active',
    created_by INTEGER,
    updated_by INTEGER,
    deleted_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME,
    FOREIGN KEY (account_id) REFERENCES expense_accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (category_id) REFERENCES expense_categories(id) ON DELETE SET NULL,
    FOREIGN KEY (reimbursement_account_id) REFERENCES expense_accounts(id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (deleted_by) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS expense_transaction_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    actor_id INTEGER,
    actor_name TEXT,
    note TEXT,
    snapshot TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (transaction_id) REFERENCES expense_transactions(id) ON DELETE CASCADE,
    FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS expense_revenues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'VND',
    revenue_date TEXT NOT NULL,
    revenue_type TEXT NOT NULL,
    description TEXT,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_by INTEGER,
    updated_by INTEGER,
    deleted_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME,
    FOREIGN KEY (account_id) REFERENCES expense_accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (deleted_by) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS expense_revenue_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    revenue_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    actor_id INTEGER,
    actor_name TEXT,
    note TEXT,
    snapshot TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (revenue_id) REFERENCES expense_revenues(id) ON DELETE CASCADE,
    FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS content_id_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'unused',
    album_title TEXT,
    song_title TEXT,
    artist TEXT,
    product_id INTEGER,
    track_id INTEGER,
    notes TEXT,
    used_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES content_id_products(id) ON DELETE SET NULL,
    FOREIGN KEY (track_id) REFERENCES content_id_tracks(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS content_id_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    network_id INTEGER NOT NULL,
    network_name TEXT,
    content_owner_id TEXT,
    claim_id TEXT,
    video_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    policy_id TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'audiovisual',
    status TEXT NOT NULL DEFAULT 'pending',
    claim_response TEXT,
    error_message TEXT,
    note TEXT,
    created_by INTEGER,
    created_by_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS content_id_claim_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL,
    action TEXT NOT NULL DEFAULT 'release',
    network_id INTEGER NOT NULL,
    network_name TEXT,
    content_owner_id TEXT,
    claim_id TEXT NOT NULL,
    video_id TEXT,
    video_title TEXT,
    channel_title TEXT,
    asset_id TEXT,
    asset_title TEXT,
    isrc TEXT,
    content_type TEXT,
    previous_status TEXT,
    result TEXT NOT NULL,
    result_status TEXT,
    message TEXT,
    note TEXT,
    response_json TEXT,
    duration_ms INTEGER,
    created_by INTEGER,
    created_by_name TEXT,
    created_by_email TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS email_notification_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    partner_id INTEGER,
    partner_name TEXT,
    recipient_email TEXT NOT NULL,
    report_month TEXT NOT NULL,
    subject TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'sent',
    error_message TEXT,
    sent_by INTEGER,
    sent_by_name TEXT,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (partner_id) REFERENCES partners(id) ON DELETE SET NULL,
    FOREIGN KEY (sent_by) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS email_notification_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_month TEXT NOT NULL,
    partner_ids TEXT NOT NULL DEFAULT '[]',
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    signature TEXT NOT NULL,
    send_at DATETIME NOT NULL,
    follow_up_days INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'scheduled',
    first_sent_at DATETIME,
    follow_up_sent_at DATETIME,
    next_run_at DATETIME NOT NULL,
    last_error TEXT,
    created_by INTEGER,
    created_by_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  );
`);

const partnerColumns = db.prepare("PRAGMA table_info(partners)").all();
if (!partnerColumns.some((column) => column.name === "contract_status")) {
  db.exec("ALTER TABLE partners ADD COLUMN contract_status TEXT NOT NULL DEFAULT 'not_created'");
}
if (!partnerColumns.some((column) => column.name === "partner_status")) {
  db.exec("ALTER TABLE partners ADD COLUMN partner_status TEXT NOT NULL DEFAULT 'active'");
}
if (!partnerColumns.some((column) => column.name === "request_token")) {
  db.exec("ALTER TABLE partners ADD COLUMN request_token TEXT");
}
if (!partnerColumns.some((column) => column.name === "request_submitted_at")) {
  db.exec("ALTER TABLE partners ADD COLUMN request_submitted_at DATETIME");
}
if (!partnerColumns.some((column) => column.name === "payment_method")) {
  db.exec("ALTER TABLE partners ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'pingpongx'");
}
if (!partnerColumns.some((column) => column.name === "bank_holder")) {
  db.exec("ALTER TABLE partners ADD COLUMN bank_holder TEXT");
}
if (!partnerColumns.some((column) => column.name === "swift_code")) {
  db.exec("ALTER TABLE partners ADD COLUMN swift_code TEXT");
}
if (!partnerColumns.some((column) => column.name === "bank_branch")) {
  db.exec("ALTER TABLE partners ADD COLUMN bank_branch TEXT");
}
if (!partnerColumns.some((column) => column.name === "contract_notes")) {
  db.exec("ALTER TABLE partners ADD COLUMN contract_notes TEXT");
}
if (!partnerColumns.some((column) => column.name === "contract_sent_at")) {
  db.exec("ALTER TABLE partners ADD COLUMN contract_sent_at DATETIME");
}
if (!partnerColumns.some((column) => column.name === "contract_signed_at")) {
  db.exec("ALTER TABLE partners ADD COLUMN contract_signed_at DATETIME");
}
if (!partnerColumns.some((column) => column.name === "contract_start_at")) {
  db.exec("ALTER TABLE partners ADD COLUMN contract_start_at DATETIME");
}
if (!partnerColumns.some((column) => column.name === "contract_end_at")) {
  db.exec("ALTER TABLE partners ADD COLUMN contract_end_at DATETIME");
}
if (!partnerColumns.some((column) => column.name === "contract_file_name")) {
  db.exec("ALTER TABLE partners ADD COLUMN contract_file_name TEXT");
}
if (!partnerColumns.some((column) => column.name === "contract_file_data_url")) {
  db.exec("ALTER TABLE partners ADD COLUMN contract_file_data_url TEXT");
}

const networkColumns = db.prepare("PRAGMA table_info(networks)").all();
if (!networkColumns.some((column) => column.name === "cms_oauth_client_id")) {
  db.exec("ALTER TABLE networks ADD COLUMN cms_oauth_client_id TEXT");
}
if (!networkColumns.some((column) => column.name === "cms_refresh_lock_id")) {
  db.exec("ALTER TABLE networks ADD COLUMN cms_refresh_lock_id TEXT");
}
if (!networkColumns.some((column) => column.name === "cms_refresh_lock_until")) {
  db.exec("ALTER TABLE networks ADD COLUMN cms_refresh_lock_until INTEGER");
}
if (!networkColumns.some((column) => column.name === "network_code")) {
  db.exec("ALTER TABLE networks ADD COLUMN network_code TEXT");
}
if (!networkColumns.some((column) => column.name === "cms_auth_status")) {
  db.exec("ALTER TABLE networks ADD COLUMN cms_auth_status TEXT NOT NULL DEFAULT 'not_connected'");
}
if (!networkColumns.some((column) => column.name === "cms_auth_email")) {
  db.exec("ALTER TABLE networks ADD COLUMN cms_auth_email TEXT");
}
if (!networkColumns.some((column) => column.name === "cms_auth_name")) {
  db.exec("ALTER TABLE networks ADD COLUMN cms_auth_name TEXT");
}
if (!networkColumns.some((column) => column.name === "cms_auth_scopes")) {
  db.exec("ALTER TABLE networks ADD COLUMN cms_auth_scopes TEXT");
}
if (!networkColumns.some((column) => column.name === "cms_access_token")) {
  db.exec("ALTER TABLE networks ADD COLUMN cms_access_token TEXT");
}
if (!networkColumns.some((column) => column.name === "cms_refresh_token")) {
  db.exec("ALTER TABLE networks ADD COLUMN cms_refresh_token TEXT");
}
if (!networkColumns.some((column) => column.name === "cms_token_expiry")) {
  db.exec("ALTER TABLE networks ADD COLUMN cms_token_expiry DATETIME");
}
if (!networkColumns.some((column) => column.name === "cms_authed_at")) {
  db.exec("ALTER TABLE networks ADD COLUMN cms_authed_at DATETIME");
}
if (!networkColumns.some((column) => column.name === "cms_auth_error")) {
  db.exec("ALTER TABLE networks ADD COLUMN cms_auth_error TEXT");
}
if (!networkColumns.some((column) => column.name === "cms_auth_generation")) {
  db.transaction(() => db.exec(`
    ALTER TABLE networks ADD COLUMN cms_auth_generation TEXT;
    UPDATE networks
    SET cms_auth_status = 'connected', cms_token_expiry = NULL, cms_auth_error = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE cms_auth_status IN ('pending', 'error')
      AND cms_authed_at IS NOT NULL
      AND LENGTH(TRIM(COALESCE(cms_refresh_token, ''))) > 0
      AND INSTR(LOWER(COALESCE(cms_auth_error, '')), 'invalid_grant') = 0;
  `))();
}

db.exec("CREATE INDEX IF NOT EXISTS idx_content_id_codes_type_status ON content_id_codes(type, status)");
db.exec("CREATE INDEX IF NOT EXISTS idx_content_id_products_created ON content_id_products(created_at)");
db.exec("CREATE INDEX IF NOT EXISTS idx_content_id_tracks_product ON content_id_tracks(product_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_content_id_track_artists_track ON content_id_track_artists(track_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_content_id_track_artists_artist ON content_id_track_artists(artist_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_content_id_claims_network_status ON content_id_claims(network_id, status)");
db.exec("CREATE INDEX IF NOT EXISTS idx_content_id_claims_video ON content_id_claims(video_id)");

// Claim Manager audit rows must outlive the CMS network they were written for: each row already
// carries the network name and content owner id, and deleting a network in Settings must not
// erase the release history. Databases created with the earlier ON DELETE CASCADE are rebuilt
// once (SQLite cannot drop a foreign key in place); the indexes are recreated right below.
if (db.pragma("foreign_key_list(content_id_claim_events)").some((fk) => fk.table === "networks")) {
  const previousForeignKeys = db.pragma("foreign_keys", { simple: true });
  db.pragma("foreign_keys = OFF");
  db.exec(`
    BEGIN;

    CREATE TABLE content_id_claim_events_migration (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_id TEXT NOT NULL,
      action TEXT NOT NULL DEFAULT 'release',
      network_id INTEGER NOT NULL,
      network_name TEXT,
      content_owner_id TEXT,
      claim_id TEXT NOT NULL,
      video_id TEXT,
      video_title TEXT,
      channel_title TEXT,
      asset_id TEXT,
      asset_title TEXT,
      isrc TEXT,
      content_type TEXT,
      previous_status TEXT,
      result TEXT NOT NULL,
      result_status TEXT,
      message TEXT,
      note TEXT,
      response_json TEXT,
      duration_ms INTEGER,
      created_by INTEGER,
      created_by_name TEXT,
      created_by_email TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    );

    INSERT INTO content_id_claim_events_migration (
      id, operation_id, action, network_id, network_name, content_owner_id, claim_id, video_id, video_title, channel_title,
      asset_id, asset_title, isrc, content_type, previous_status, result, result_status, message, note, response_json,
      duration_ms, created_by, created_by_name, created_by_email, created_at
    )
    SELECT id, operation_id, action, network_id, network_name, content_owner_id, claim_id, video_id, video_title, channel_title,
      asset_id, asset_title, isrc, content_type, previous_status, result, result_status, message, note, response_json,
      duration_ms, created_by, created_by_name, created_by_email, created_at
    FROM content_id_claim_events;

    DROP TABLE content_id_claim_events;
    ALTER TABLE content_id_claim_events_migration RENAME TO content_id_claim_events;

    COMMIT;
  `);
  db.pragma(`foreign_keys = ${previousForeignKeys ? "ON" : "OFF"}`);
}

db.exec("CREATE INDEX IF NOT EXISTS idx_cid_claim_events_network_claim ON content_id_claim_events(network_id, claim_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_cid_claim_events_created ON content_id_claim_events(created_at)");
db.exec("CREATE INDEX IF NOT EXISTS idx_cid_claim_events_operation ON content_id_claim_events(operation_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_cid_claim_events_result ON content_id_claim_events(result)");
db.exec("CREATE INDEX IF NOT EXISTS idx_expense_transactions_account_date ON expense_transactions(account_id, transaction_date)");
db.exec("CREATE INDEX IF NOT EXISTS idx_expense_revenues_account_date ON expense_revenues(account_id, revenue_date)");

const contentProductColumns = db.prepare("PRAGMA table_info(content_id_products)").all();
if (!contentProductColumns.some((column) => column.name === "label_id")) {
  db.exec("ALTER TABLE content_id_products ADD COLUMN label_id INTEGER");
}

const managedChannelColumns = db.prepare("PRAGMA table_info(managed_channels)").all();
if (!managedChannelColumns.some((column) => column.name === "unlinked_at")) {
  db.exec("ALTER TABLE managed_channels ADD COLUMN unlinked_at DATETIME");
}

const groupColumns = db.prepare("PRAGMA table_info(channel_groups)").all();
const hasGroupFeeRate = groupColumns.some((column) => column.name === "fee_rate");
if (!hasGroupFeeRate) {
  db.exec("ALTER TABLE channel_groups ADD COLUMN fee_rate REAL NOT NULL DEFAULT 0");
}
const hasGroupRevenueTax = groupColumns.some((column) => column.name === "apply_revenue_tax");
if (!hasGroupRevenueTax) {
  db.exec("ALTER TABLE channel_groups ADD COLUMN apply_revenue_tax INTEGER NOT NULL DEFAULT 0");
}

const groupChannelColumns = db.prepare("PRAGMA table_info(group_channels)").all();
const hasCustomShareOverride = groupChannelColumns.some((column) => column.name === "custom_share_override");
if (!hasCustomShareOverride) {
  db.exec("ALTER TABLE group_channels ADD COLUMN custom_share_override INTEGER NOT NULL DEFAULT 0");
  db.exec(`
    UPDATE group_channels
    SET custom_share_override = CASE
      WHEN custom_share IS NOT NULL AND custom_share != 0 THEN 1
      ELSE 0
    END
  `);
}

db.exec("CREATE INDEX IF NOT EXISTS idx_channel_network_history_channel_month ON channel_network_history(channel_id, start_month)");

const revenueColumns = db.prepare("PRAGMA table_info(channel_revenues)").all();
const hasRevenueNetwork = revenueColumns.some((column) => column.name === "network_id");
const hasRevenueImport = revenueColumns.some((column) => column.name === "import_id");

if (!hasRevenueNetwork) {
  db.exec("ALTER TABLE channel_revenues ADD COLUMN network_id INTEGER");
}

if (!hasRevenueImport) {
  db.exec("ALTER TABLE channel_revenues ADD COLUMN import_id INTEGER");
}

const hasRevenueUs = revenueColumns.some((column) => column.name === "revenue_us");
const hasRevenueBr = revenueColumns.some((column) => column.name === "revenue_br");

if (!hasRevenueUs) {
  db.exec("ALTER TABLE channel_revenues ADD COLUMN revenue_us REAL NOT NULL DEFAULT 0");
}

if (!hasRevenueBr) {
  db.exec("ALTER TABLE channel_revenues ADD COLUMN revenue_br REAL NOT NULL DEFAULT 0");
}

const revenueIndexes = db.prepare("PRAGMA index_list(channel_revenues)").all();
const hasOldMonthChannelUnique = revenueIndexes.some((index) => {
  if (!index.unique || index.name === "idx_channel_revenues_month_network_channel") return false;
  const columns = db.prepare(`PRAGMA index_info(${index.name})`).all().map((column) => column.name);
  return columns.length === 2 && columns[0] === "month" && columns[1] === "channel_id";
});

if (hasOldMonthChannelUnique) {
  db.exec(`
    ALTER TABLE channel_revenues RENAME TO channel_revenues_old;

    CREATE TABLE channel_revenues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month TEXT NOT NULL,
      network_id INTEGER,
      channel_id TEXT NOT NULL,
      revenue REAL NOT NULL DEFAULT 0,
      revenue_us REAL NOT NULL DEFAULT 0,
      revenue_br REAL NOT NULL DEFAULT 0,
      source_file TEXT,
      import_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    INSERT INTO channel_revenues (
      id, month, network_id, channel_id, revenue, revenue_us, revenue_br, source_file, import_id, created_at, updated_at
    )
    SELECT id, month, network_id, channel_id, revenue, revenue_us, revenue_br, source_file, import_id, created_at, updated_at
    FROM channel_revenues_old;

    DROP TABLE channel_revenues_old;
  `);
}

db.exec("DROP INDEX IF EXISTS idx_channel_revenues_month_network_channel");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_revenues_month_network_channel ON channel_revenues(month, network_id, channel_id)");

const channelGroupColumns = db.prepare("PRAGMA table_info(channel_groups)").all();
const groupPartnerColumn = channelGroupColumns.find((column) => column.name === "partner_id");
const groupHasCollaborator = channelGroupColumns.some((column) => column.name === "collaborator_id");

if (!groupHasCollaborator || groupPartnerColumn?.notnull) {
  const previousForeignKeys = db.pragma("foreign_keys", { simple: true });
  db.pragma("foreign_keys = OFF");
  db.exec(`
    BEGIN;

    CREATE TABLE channel_groups_migration (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      partner_id INTEGER,
      collaborator_id INTEGER,
      group_name TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      fee_rate REAL NOT NULL DEFAULT 0,
      apply_revenue_tax INTEGER NOT NULL DEFAULT 0,
      description TEXT,
      tiers TEXT NOT NULL DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (partner_id) REFERENCES partners(id) ON DELETE CASCADE,
      FOREIGN KEY (collaborator_id) REFERENCES collaborators(id) ON DELETE CASCADE
    );

    INSERT INTO channel_groups_migration (
      id, partner_id, collaborator_id, group_name, currency, fee_rate, apply_revenue_tax, description, tiers, created_at, updated_at
    )
    SELECT id, partner_id, ${groupHasCollaborator ? "collaborator_id" : "NULL"}, group_name, currency, fee_rate, apply_revenue_tax, description, tiers, created_at, updated_at
    FROM channel_groups;

    DROP TABLE channel_groups;
    ALTER TABLE channel_groups_migration RENAME TO channel_groups;

    COMMIT;
  `);
  db.pragma(`foreign_keys = ${previousForeignKeys ? "ON" : "OFF"}`);
}

const adminEmail = "admin";
const existingAdmin = db
  .prepare("SELECT * FROM users WHERE email = ?")
  .get(adminEmail);

if (!existingAdmin) {
  const hashedPassword = bcrypt.hashSync("Hoangtinh@0910", 10);

  db.prepare(`
    INSERT INTO users (full_name, email, password, role, status)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    "System Admin",
    adminEmail,
    hashedPassword,
    "admin",
    "active"
  );

  console.log("Default admin created:");
  console.log("Email: admin");
  console.log("Password: Hoangtinh@0910");
}

// CMS Delivery: products delivered straight to YouTube CMS through the Content ID API
// (one sound_recording asset + audio reference per track), kept locally for later management.
db.exec(`
  CREATE TABLE IF NOT EXISTS content_id_delivery_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    network_id INTEGER NOT NULL,
    network_name TEXT,
    content_owner_id TEXT,
    title TEXT NOT NULL,
    artist TEXT,
    upc TEXT,
    label TEXT,
    genre TEXT,
    release_date TEXT,
    artwork_name TEXT,
    artwork_data_url TEXT,
    notes TEXT,
    asset_labels TEXT,
    ownership_json TEXT,
    match_policy_id TEXT,
    match_policy_name TEXT,
    reference_content_type TEXT NOT NULL DEFAULT 'audio',
    reference_urgent INTEGER NOT NULL DEFAULT 0,
    skip_duplicates INTEGER NOT NULL DEFAULT 1,
    include_reference INTEGER NOT NULL DEFAULT 1,
    delete_reference_after_delivery INTEGER NOT NULL DEFAULT 0,
    asset_type TEXT NOT NULL DEFAULT 'sound_recording',
    track_count INTEGER NOT NULL DEFAULT 0,
    delivered_count INTEGER NOT NULL DEFAULT 0,
    completed_count INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'draft',
    error_message TEXT,
    created_by INTEGER,
    created_by_name TEXT,
    delivered_at DATETIME,
    last_synced_at DATETIME,
    job_started_at DATETIME,
    job_finished_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_cid_delivery_products_network ON content_id_delivery_products(network_id, status);
  CREATE INDEX IF NOT EXISTS idx_cid_delivery_products_upc ON content_id_delivery_products(upc);

  CREATE TABLE IF NOT EXISTS content_id_delivery_tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    track_number INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL,
    artist TEXT,
    isrc TEXT NOT NULL,
    custom_id TEXT,
    notes TEXT,
    description TEXT,
    source_url TEXT,
    asset_labels TEXT,
    file_name TEXT,
    file_size INTEGER,
    file_path TEXT,
    file_mime TEXT,
    file_sha256 TEXT,
    file_uploaded_at DATETIME,
    metadata_json TEXT,
    ownership_json TEXT,
    match_policy_id TEXT,
    match_policy_name TEXT,
    steps_json TEXT,
    asset_id TEXT,
    asset_status TEXT,
    reference_id TEXT,
    reference_status TEXT,
    reference_content_type TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    step TEXT,
    error_message TEXT,
    response_json TEXT,
    duplicate_json TEXT,
    cms_json TEXT,
    delivered_at DATETIME,
    last_synced_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES content_id_delivery_products(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_cid_delivery_tracks_product ON content_id_delivery_tracks(product_id, track_number);
  CREATE INDEX IF NOT EXISTS idx_cid_delivery_tracks_isrc ON content_id_delivery_tracks(isrc);
  CREATE INDEX IF NOT EXISTS idx_cid_delivery_tracks_asset ON content_id_delivery_tracks(asset_id);

  CREATE TABLE IF NOT EXISTS content_id_delivery_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    track_id INTEGER,
    action TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ok',
    message TEXT,
    payload_json TEXT,
    created_by INTEGER,
    created_by_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES content_id_delivery_products(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_cid_delivery_events_product ON content_id_delivery_events(product_id, id);
  CREATE INDEX IF NOT EXISTS idx_cid_delivery_events_track ON content_id_delivery_events(track_id, id);

  CREATE TABLE IF NOT EXISTS content_id_delivery_audio_uploads (
    id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_size INTEGER NOT NULL DEFAULT 0,
    file_mime TEXT,
    file_sha256 TEXT,
    created_by INTEGER,
    created_by_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_cid_delivery_audio_uploads_expires ON content_id_delivery_audio_uploads(expires_at);
`);

// v3: audio files are stored on the server (backend/data/delivery-media) and the reference is
// delivered by a background job. Existing databases get the new columns through guarded ALTERs.
const deliveryTrackColumns = db.prepare("PRAGMA table_info(content_id_delivery_tracks)").all();
if (!deliveryTrackColumns.some((column) => column.name === "file_path")) {
  db.exec("ALTER TABLE content_id_delivery_tracks ADD COLUMN file_path TEXT");
}
if (!deliveryTrackColumns.some((column) => column.name === "file_mime")) {
  db.exec("ALTER TABLE content_id_delivery_tracks ADD COLUMN file_mime TEXT");
}
if (!deliveryTrackColumns.some((column) => column.name === "file_sha256")) {
  db.exec("ALTER TABLE content_id_delivery_tracks ADD COLUMN file_sha256 TEXT");
}
if (!deliveryTrackColumns.some((column) => column.name === "file_uploaded_at")) {
  db.exec("ALTER TABLE content_id_delivery_tracks ADD COLUMN file_uploaded_at DATETIME");
}

const deliveryProductColumns = db.prepare("PRAGMA table_info(content_id_delivery_products)").all();
if (!deliveryProductColumns.some((column) => column.name === "include_reference")) {
  db.exec("ALTER TABLE content_id_delivery_products ADD COLUMN include_reference INTEGER NOT NULL DEFAULT 1");
}
if (!deliveryProductColumns.some((column) => column.name === "job_started_at")) {
  db.exec("ALTER TABLE content_id_delivery_products ADD COLUMN job_started_at DATETIME");
}
if (!deliveryProductColumns.some((column) => column.name === "job_finished_at")) {
  db.exec("ALTER TABLE content_id_delivery_products ADD COLUMN job_finished_at DATETIME");
}
// v4: optional removal of the stored audio once its reference has been delivered.
if (!deliveryProductColumns.some((column) => column.name === "delete_reference_after_delivery")) {
  db.exec("ALTER TABLE content_id_delivery_products ADD COLUMN delete_reference_after_delivery INTEGER NOT NULL DEFAULT 0");
}
// v5: video delivery. A product carries the Content ID asset type of its items
// (sound_recording | web | music_video); video items have a description and an official URL.
if (!deliveryProductColumns.some((column) => column.name === "asset_type")) {
  db.exec("ALTER TABLE content_id_delivery_products ADD COLUMN asset_type TEXT NOT NULL DEFAULT 'sound_recording'");
}
if (!deliveryTrackColumns.some((column) => column.name === "description")) {
  db.exec("ALTER TABLE content_id_delivery_tracks ADD COLUMN description TEXT");
}
if (!deliveryTrackColumns.some((column) => column.name === "source_url")) {
  db.exec("ALTER TABLE content_id_delivery_tracks ADD COLUMN source_url TEXT");
}

db.exec(`
  CREATE TABLE IF NOT EXISTS ownership_channels (
    channel_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    owner_count INTEGER NOT NULL DEFAULT 0,
    checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS ownership_channel_owners (
    channel_id TEXT NOT NULL REFERENCES ownership_channels(channel_id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL,
    cms_name TEXT NOT NULL,
    cms_name_key TEXT NOT NULL,
    email TEXT,
    evidence INTEGER NOT NULL,
    asset_url TEXT,
    video_id TEXT,
    PRIMARY KEY (channel_id, owner_id)
  );
  CREATE INDEX IF NOT EXISTS idx_ownership_cms_name ON ownership_channel_owners(channel_id, cms_name_key);
  CREATE TABLE IF NOT EXISTS ownership_api_keys (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at TEXT
  );
`);

module.exports = db;
