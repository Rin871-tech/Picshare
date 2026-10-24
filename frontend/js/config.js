// Public configuration only. Same-origin Express hosting needs no API override.
// For a separate frontend host, set this to the deployed HTTPS backend + /api.
window.PICSHARE_API_URL ||= '';
// Development tiles. Choose a production provider and its required attribution before launch.
window.PICSHARE_MAP_TILES ||= 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
window.PICSHARE_MAP_ATTRIBUTION ||= '© OpenStreetMap contributors';
