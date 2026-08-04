function getAssetVersion(env = process.env) {
  const configured = String(env.ASSET_VERSION || '').trim();
  if (configured) return configured;
  return `v${Date.now()}`;
}

function applyCacheHeaders(req, res, next) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
}

module.exports = {
  getAssetVersion,
  applyCacheHeaders
};
