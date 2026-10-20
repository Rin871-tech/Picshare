(() => {
  const API_BASE = window.PICSHARE_API_URL || (window.location.port === '5500' || window.location.port === '5501' ? 'http://localhost:4000/api' : `${window.location.origin}/api`);
  const API_ORIGIN = API_BASE.replace(/\/api\/?$/, '');
  const TOKEN_KEY = 'picshare_token';
  const api = {
    get token() { return localStorage.getItem(TOKEN_KEY); },
    setToken(token) { if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY); },
    async request(path, options = {}) {
      const headers = { ...(options.headers || {}) };
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      const isForm = options.body instanceof FormData;
      if (options.body && !isForm && typeof options.body !== 'string') {
        headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(options.body);
      }
      const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
      const contentType = response.headers.get('content-type') || '';
      let data = {};
      if (contentType.includes('application/json')) {
        data = await response.json().catch(() => ({}));
      } else {
        const text = await response.text().catch(() => '');
        data = { error: text && text.length < 200 ? text : undefined };
      }
      if (!response.ok) {
        if (response.status === 401 && this.token && !path.includes('/auth/')) {
          window.dispatchEvent(new CustomEvent('picshare:unauthorized'));
        }
        const defaultMessages = {
          400: 'Invalid input. Please check the fields and try again.',
          401: 'Incorrect email or password.',
          403: 'Access denied.',
          404: 'The requested item was not found.',
          409: 'An account with that username or email already exists.',
          429: 'Too many attempts. Please try again in a few minutes.',
          500: 'Server error. Please try again later.'
        };
        const message = data.error || data.message || defaultMessages[response.status] || 'Request failed. Please try again.';
        const err = new Error(message);
        err.status = response.status;
        err.data = data;
        throw err;
      }
      return data;
    },
    get(path) { return this.request(path); },
    post(path, body) { return this.request(path, { method: 'POST', body }); },
    patch(path, body) { return this.request(path, { method: 'PATCH', body }); },
    delete(path) { return this.request(path, { method: 'DELETE' }); },
    upload(path, formData) { return this.request(path, { method: 'POST', body: formData }); },
    image(url) { return url ? (url.startsWith('http') ? url : `${API_ORIGIN}${url}`) : ''; }
  };
  window.PicShareAPI = api;
})();
