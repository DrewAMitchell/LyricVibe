/* Pure YouTube DOM snapshot policy. Ad selectors remain observed site details. */
(function (root) {
  'use strict';
  function parseIsoDurationMs(value) {
    if (typeof value !== 'string') return null;
    const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value.trim());
    if (!match || value.trim().endsWith('T') || !match.slice(1).some(part => part !== undefined)) return null;
    const ms = ((Number(match[1] || 0) * 24 + Number(match[2] || 0)) * 3600 + Number(match[3] || 0) * 60 + Number(match[4] || 0)) * 1000;
    return Number.isFinite(ms) && ms >= 0 && Number.isSafeInteger(Math.round(ms)) ? Math.round(ms) : null;
  }
  function videoIdFromUrl(value) {
    try {
      const url = new URL(value);
      if (!['www.youtube.com', 'youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(url.hostname)) return null;
      const id = url.searchParams.get('v');
      return url.pathname === '/watch' && /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null;
    } catch (_) { return null; }
  }
  function isAdActive(snapshot) {
    const classes = new Set(String(snapshot.playerClassName || '').split(/\s+/));
    return classes.has('ad-showing') || classes.has('ad-interrupting');
  }
  function inspect(snapshot) {
    const adActive = isAdActive(snapshot);
    const sourceVideoId = videoIdFromUrl(snapshot.url);
    const metadataVideoId = videoIdFromUrl(snapshot.canonicalUrl);
    const metadataMatches = Boolean(sourceVideoId && metadataVideoId && sourceVideoId === metadataVideoId);
    const metadataDurationMs = metadataMatches ? parseIsoDurationMs(snapshot.isoDuration) : null;
    const nativeDurationMs = Number.isFinite(snapshot.mediaDurationSec) && snapshot.mediaDurationSec > 0 ? Math.round(snapshot.mediaDurationSec * 1000) : null;
    // Metadata's integer seconds can differ from native media by encoder padding.
    // A 2s tolerance is provisional, not proof of source correspondence.
    const durationMatches = metadataDurationMs > 0 && nativeDurationMs > 0 && Math.abs(metadataDurationMs - nativeDurationMs) <= 2000;
    const contentDurationMs = metadataDurationMs > 0 ? metadataDurationMs : null;
    let reason = null;
    if (adActive) reason = 'YOUTUBE_AD_ACTIVE';
    else if (!metadataMatches) reason = 'YOUTUBE_METADATA_SOURCE_UNVERIFIED';
    else if (!contentDurationMs) reason = 'YOUTUBE_CONTENT_DURATION_UNAVAILABLE';
    else if (!durationMatches) reason = 'YOUTUBE_MEDIA_DURATION_MISMATCH';
    else if (!Number.isFinite(snapshot.mediaCurrentTimeSec) || snapshot.mediaCurrentTimeSec < 0) reason = 'YOUTUBE_MEDIA_CLOCK_UNAVAILABLE';
    const clockUsable = !reason;
    // Catalog rounding must use the verified recording, not integer page metadata.
    const lookupDurationMs = clockUsable ? nativeDurationMs : contentDurationMs;
    return { adActive, contentDurationMs, nativeDurationMs, lookupDurationMs, durationMatches, metadataMatches, sourceVideoId, clockUsable, reason, paused: !clockUsable || Boolean(snapshot.mediaPaused), seeking: !clockUsable || Boolean(snapshot.mediaSeeking) };
  }
  const api = { parseIsoDurationMs, videoIdFromUrl, isAdActive, inspect };
  root.LvYoutubeMedia = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
