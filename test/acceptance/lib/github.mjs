// A small GitHub REST client for the acceptance scripts. The token comes from the caller and is only sent to the API.
export class GitHub {
  constructor(token, { apiUrl = 'https://api.github.com' } = {}) {
    if (!token) throw new Error('a GitHub token is required');
    this.token = token; this.apiUrl = apiUrl.replace(/\/$/, '');
  }
  async request(method, path, body) {
    const response = await fetch(this.apiUrl + path, { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.status === 204) return null;
    const text = await response.text(); let value = null; try { value = text ? JSON.parse(text) : null; } catch {}
    if (!response.ok) {
      const error = new Error(`GitHub ${method} ${path} -> ${response.status} ${value?.message || ''}`.trim()); error.status = response.status;
      throw error;
    }
    return value;
  }
  /** Every page of a list endpoint (100 per page). */
  async all(path) {
    const items = [];
    for (let page = 1; ; page++) {
      const batch = await this.request('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      items.push(...batch);
      if (batch.length < 100) return items;
    }
  }
}
