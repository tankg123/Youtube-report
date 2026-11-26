const db = require("../config/database");

// These indexes are persisted. Higher ranks retain the strongest observed link.
const EVIDENCE = ["title", "reference_video", "upload_claim", "channel_manager"];

function cmsNameKey(name) {
  return name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function distinctOwners(result) {
  const owners = new Map();
  function add(contact, evidence, assetUrl = null, videoId = null) {
    if (!contact?.owner_id) return;
    const previous = owners.get(contact.owner_id);
    const better = !previous || EVIDENCE.indexOf(evidence) > EVIDENCE.indexOf(previous.evidence);
    owners.set(contact.owner_id, {
      owner_id: contact.owner_id,
      cms_name: contact.name || previous?.cms_name || "",
      email: contact.email || previous?.email || null,
      evidence: better ? evidence : previous.evidence,
      asset_url: better ? assetUrl : previous.asset_url,
      video_id: better ? videoId : previous.video_id
    });
  }
  add(result.channel.manager, "channel_manager");
  for (const video of result.videos) {
    for (const asset of video.assets) {
      for (const contact of asset.owners) add(contact, asset.evidence, asset.ownership_url, video.id);
    }
  }
  return [...owners.values()];
}

const recordLookup = db.transaction((result, isChannel) => {
  const { id, title } = result.channel;
  db.prepare(`INSERT INTO ownership_channels(channel_id, title) VALUES (?, ?)
    ON CONFLICT(channel_id) DO UPDATE SET title = excluded.title, checked_at = CURRENT_TIMESTAMP`).run(id, title);
  const write = db.prepare(`INSERT INTO ownership_channel_owners
    (channel_id, owner_id, cms_name, cms_name_key, email, evidence, asset_url, video_id)
    VALUES (@channel, @owner_id, @cms_name, @name_key, @email, @rank, @asset_url, @video_id)
    ON CONFLICT(channel_id, owner_id) DO UPDATE SET
      cms_name = COALESCE(NULLIF(excluded.cms_name, ''), cms_name),
      cms_name_key = COALESCE(NULLIF(excluded.cms_name_key, ''), cms_name_key),
      email = CASE WHEN excluded.cms_name != '' THEN excluded.email ELSE COALESCE(excluded.email, email) END,
      asset_url = CASE WHEN excluded.evidence >= evidence THEN excluded.asset_url ELSE asset_url END,
      video_id = CASE WHEN excluded.evidence >= evidence THEN excluded.video_id ELSE video_id END,
      evidence = MAX(evidence, excluded.evidence)`);
  const current = distinctOwners(result);
  for (const owner of current) {
    write.run({ ...owner, channel: id, name_key: cmsNameKey(owner.cms_name), rank: EVIDENCE.indexOf(owner.evidence) });
  }
  const stored = db.prepare(`SELECT owner_id, cms_name, email, evidence, asset_url, video_id
    FROM ownership_channel_owners WHERE channel_id = ? ORDER BY cms_name_key, owner_id`).all(id);
  db.prepare("UPDATE ownership_channels SET owner_count = ? WHERE channel_id = ?").run(stored.length, id);
  const byId = new Map(current.map((owner) => [owner.owner_id, owner]));
  const owners = stored.filter((owner) => isChannel || byId.has(owner.owner_id)).map((owner) => {
    if (isChannel) return { ...owner, evidence: EVIDENCE[owner.evidence] };
    const { evidence, asset_url, video_id } = byId.get(owner.owner_id);
    return { ...owner, evidence, asset_url, video_id };
  });
  return { owners, channel_owner_count: stored.length };
});

function findChannelContact(channelId, name) {
  const rows = db.prepare(`SELECT cms_name, email FROM ownership_channel_owners
    WHERE channel_id = ? AND cms_name_key = ? AND evidence >= ? ORDER BY evidence DESC, owner_id`).all(channelId, cmsNameKey(name), EVIDENCE.indexOf("reference_video"));
  if (!rows.length) return null;
  const emails = new Map(rows.filter((row) => row.email).map((row) => [row.email.toLowerCase(), row.email]));
  const sameContact = emails.size === 1 && rows.every((row) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email || ""));
  return { name: rows[0].cms_name, email: sameContact ? [...emails.values()][0] : null };
}

module.exports = { cmsNameKey, recordLookup, findChannelContact };
