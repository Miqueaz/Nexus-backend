/** Adaptador HTTP para reemplazar progresivamente la persistencia local del frontend.
 * Token solo en memoria. Al recargar, se inicia sesión nuevamente.
 * No contiene credenciales ni dependencia de un framework.
 */
export function createNexoApi({ baseUrl = 'http://localhost:3000/api/v1' } = {}) {
  let token = null;
  async function request(path, { method = 'GET', body, key, historyAt } = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
        ...(historyAt ? { 'X-History-At': historyAt } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 401) token = null;
      const error = new Error(result.error?.message ?? 'No se pudo completar la solicitud');
      error.code = result.error?.code;
      error.status = response.status;
      error.details = result.error?.details;
      error.requestId = result.error?.requestId;
      throw error;
    }
    return result;
  }
  return {
    async register(body) {
      const session = await request('/auth/register', { method: 'POST', body });
      token = session.accessToken;
      return session.user;
    },
    async login(email, password) {
      const session = await request('/auth/login', { method: 'POST', body: { email, password } });
      token = session.accessToken;
      return session.user;
    },
    async logout() {
      try {
        await request('/auth/logout', { method: 'POST' });
      } finally {
        token = null;
      }
    },
    me: () => request('/auth/me'),
    businesses: () => request('/businesses'),
    createBusiness: (body) => request('/businesses', { method: 'POST', body }),
    forBusiness(businessId) {
      const base = `/businesses/${encodeURIComponent(businessId)}`;
      return {
        list: (resource, query = {}) =>
          request(`${base}/${resource}?${new URLSearchParams(query)}`),
        get: (resource, id) => request(`${base}/${resource}/${encodeURIComponent(id)}`),
        // Conserva key para repetir el mismo intento tras una desconexión.
        create: (resource, body, key = crypto.randomUUID()) =>
          request(`${base}/${resource}`, { method: 'POST', body, key }),
        patch: (resource, id, body) =>
          request(`${base}/${resource}/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
        command: (path, body, key = crypto.randomUUID()) =>
          request(`${base}/${path}`, { method: 'POST', body, key }),
        history: (collection, at, query = {}) =>
          request(`${base}/history?${new URLSearchParams({ collection, at, ...query })}`),
        calendar: (from, to) => request(`${base}/calendar?${new URLSearchParams({ from, to })}`),
      };
    },
  };
}
