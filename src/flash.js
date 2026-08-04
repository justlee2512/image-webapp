function setFlash(req, type, message) {
  if (!req?.session) return;
  req.session[type] = message;
}

function clearFlash(req) {
  if (!req?.session) return;
  delete req.session.error;
  delete req.session.success;
}

module.exports = { setFlash, clearFlash };
