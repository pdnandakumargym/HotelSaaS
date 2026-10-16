/**
 * Reads ?token from the URL fragment (#token=...). Fragments are never sent to servers or in
 * Referer headers. The fragment is removed from the address bar after reading.
 */
export function takeFragmentToken(win: Window = window): string | null {
  const params = new URLSearchParams(win.location.hash.replace(/^#/, ''));
  const token = params.get('token');
  if (token) win.history.replaceState(null, '', win.location.pathname + win.location.search);
  return token && /^[A-Za-z0-9_-]{20,200}$/.test(token) ? token : null;
}
