// Credentials typed into a login form, held only in memory between the form submit and the next page load (a real navigation
// destroys the page's JS, so it cannot carry them itself). Keyed by the sender's webContents id; expires after 60s; never written
// to disk, and never handed to page scripts - only back to the same tab's preload. Entries that are never collected (the page
// never reloaded, the tab was closed) are swept on every stash and removed when their tab's page is destroyed (tabManager), so a
// typed password cannot sit in memory for ever.
const TTL_MS = 60 * 1000;
const pending = new Map();   // webContentsId -> { origin, username, password, at }

function sweep() {
  const now = Date.now();
  for (const [id, p] of pending) if (now - p.at > TTL_MS) pending.delete(id);
}

function stash(wcId, origin, username, password) {
  sweep();
  pending.set(wcId, { origin, username: String(username), password: String(password), at: Date.now() });
}

// One-shot: returns the stashed credential only if this tab is still on the same origin.
function take(wcId, origin) {
  const p = pending.get(wcId);
  pending.delete(wcId);
  if (!p || Date.now() - p.at > TTL_MS || p.origin !== origin) return null;
  return { username: p.username, password: p.password };
}

function clear(wcId) { pending.delete(wcId); }
function size() { return pending.size; }

module.exports = { stash, take, clear, size };
