import api from "./api";

export async function listContentIdClaimCmsAccounts() {
  const response = await api.get("/content-id/cms-networks");
  return (response.data.networks || []).map((network) => ({
    id: network.id,
    cms_name: network.name,
    google_email: network.cms_auth_email,
    status: network.cms_auth_status,
    scopes: network.cms_auth_scopes || ""
  }));
}

export async function searchContentIdClaims(payload, { signal } = {}) {
  const response = await api.post("/content-id/claims/search", payload, { signal, timeout: 90000 });
  return response.data.data;
}

export async function releaseContentIdClaims(releases, { signal } = {}) {
  const response = await api.post("/content-id/claims/release", { releases }, { signal, timeout: 240000 });
  return response.data.data;
}
