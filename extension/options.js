const baseInput = document.getElementById('base');
const status = document.getElementById('status');
chrome.storage.local.get('lvPackageBase').then(value => { baseInput.value = value.lvPackageBase || ''; });
document.getElementById('endpoint').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const url = new URL(baseInput.value.trim());
    if (url.username || url.password || url.search || url.hash) throw new Error('Use a base URL without credentials, query, or fragment.');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Use HTTPS, or HTTP on localhost.');
    if (!await chrome.permissions.request({ origins: [`${url.origin}/*`] })) throw new Error('Browser endpoint permission was not granted.');
    await chrome.storage.local.set({ lvPackageBase: url.href.replace(/\/$/, '') });
    status.textContent = 'Endpoint saved. Existing local scores stay in use; new videos try this endpoint first.';
  } catch (error) { status.textContent = error.message; }
});
document.getElementById('disable').addEventListener('click', async () => { await chrome.storage.local.remove('lvPackageBase'); baseInput.value = ''; status.textContent = 'Automatic lyric lookup enabled without a package endpoint.'; });
document.getElementById('clear-model').addEventListener('click', async () => {
  const result = await chrome.runtime.sendMessage({ type: 'LV_ANALYSIS_CACHE_CLEAR_REQUEST' });
  status.textContent = result?.ok ? 'Model cache cleared. Analysis stopped.' : result?.error?.message || 'Cache could not be cleared.';
});
