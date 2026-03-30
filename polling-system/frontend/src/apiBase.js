// runtime API base resolver for the bridge HTTP API
let API_BASE = '';
  if (typeof window !== 'undefined') {
  if (window.__BRIDGE_API__) {
    API_BASE = window.__BRIDGE_API__;
  } else if (window.location.port === '5173' || window.location.hostname === 'localhost') {
    // when running via Vite dev server (default port 5173) use /api prefix so Vite proxy applies
    API_BASE = '/api';
  } else {
    API_BASE = `${window.location.protocol}//${window.location.hostname}:3002`;
  }
} else {
  API_BASE = 'http://localhost:3002';
}

export default API_BASE;
