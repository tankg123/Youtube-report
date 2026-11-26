const service = require("./assetDeliveryService");
const store = require("./deliveryStore");

function contact(ownerId, data) {
  const email = String(data?.conflictNotificationEmail || "").trim();
  return { owner_id: ownerId, name: String(data?.displayName || "").trim(),
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null };
}

async function getOwnershipContact(ctx, ownerId) {
  try {
    const { data } = await service.partnerRequest(ctx, "GET", `/contentOwners/${encodeURIComponent(ownerId)}`, {
      params: { fields: "id,displayName,conflictNotificationEmail" }
    });
    return contact(ownerId, data);
  } catch (error) {
    if (![403, 404].includes(Number(error.status)) || store.isQuotaReason(error.reason) || store.isCmsCredentialError(error)) throw error;
    return { owner_id: ownerId, name: "", email: null };
  }
}

// A mixed list can omit a restricted owner, or the CMS may reject the whole list.
// Use the original single-owner lookup only for contacts the list could not resolve.
async function getOwnershipContacts(ctx, ids) {
  const found = new Map();
  try {
    const { data } = await service.partnerRequest(ctx, "GET", "/contentOwners", {
      params: { id: ids.join(","), fields: "items(id,displayName,conflictNotificationEmail)" }
    });
    for (const owner of data?.items || []) found.set(owner.id, contact(owner.id, owner));
  } catch (error) {
    ctx.signal?.throwIfAborted();
    if (![400, 403, 404].includes(error.status) || store.isQuotaReason(error.reason) || store.isCmsCredentialError(error)) {
      for (const id of ids) found.set(id, { ...contact(id), contact_error: store.errorMessage(error) });
      return found;
    }
  }
  const missing = ids.filter((id) => !found.has(id));
  await service.mapWithConcurrency(missing, 3, async (id) => {
    try {
      found.set(id, await getOwnershipContact(ctx, id));
    } catch (error) {
      ctx.signal?.throwIfAborted();
      found.set(id, { ...contact(id), contact_error: store.errorMessage(error) });
    }
  });
  return found;
}

module.exports = { getOwnershipContact, getOwnershipContacts };
