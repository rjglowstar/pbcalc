// One-time permission to read ONE saved password: given by the main process only after the vault password was typed correctly
// (popup.askVaultPassword), for one page (webContents), one origin and one username, and valid for 30 seconds. `vault:get-password`
// refuses everything without it - including a page script calling window.vaultAPI.getPassword itself.
const TTL_MS = 30 * 1000;
const grants = new Map();   // webContentsId -> { origin, username, exp }

function grant(wcId, origin, username) { grants.set(wcId, { origin, username, exp: Date.now() + TTL_MS }); }

// true once, and only for exactly what was granted
function take(wcId, origin, username) {
  const g = grants.get(wcId);
  grants.delete(wcId);
  return !!g && g.exp > Date.now() && g.origin === origin && g.username === username;
}

function clear(wcId) { grants.delete(wcId); }
function _size() { return grants.size; }

module.exports = { grant, take, clear, TTL_MS, _size };
