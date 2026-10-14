const test = require('node:test');
const assert = require('node:assert/strict');
const media = require('../extension/youtube-media.js');
const snapshot = { url: 'https://www.youtube.com/watch?v=FIXTURE0003', canonicalUrl: 'https://www.youtube.com/watch?v=FIXTURE0003', isoDuration: 'PT3M32S', playerClassName: 'html5-video-player ad-created paused-mode', mediaDurationSec: 211.521, mediaCurrentTimeSec: 0, mediaPaused: false, mediaSeeking: false };

test('ISO duration parses YouTube main metadata without adopting ad duration', () => {
  assert.equal(media.parseIsoDurationMs('PT3M32S'), 212000);
  assert.equal(media.parseIsoDurationMs('PT2M46S'), 166000);
  assert.equal(media.parseIsoDurationMs('P1DT2H3M4.5S'), 93784500);
  for (const invalid of ['PT', 'P', 'P1DT', '-PT1S', 'PTNaNS', 'P2M', '15.421', null]) assert.equal(media.parseIsoDurationMs(invalid), null);
});

test('ad-created is not an active ad; exact showing and interrupting class tokens gate', () => {
  assert.equal(media.isAdActive(snapshot), false);
  assert.equal(media.isAdActive({ playerClassName: 'html5-video-player ad-showing' }), true);
  assert.equal(media.isAdActive({ playerClassName: 'ad-interrupting playing-mode' }), true);
  assert.equal(media.isAdActive({ playerClassName: 'not-ad-showing ad-created' }), false);
});

test('actual main-video DOM values observed 2026-10-10 allow clock with encoder padding tolerance', () => {
  const actual = media.inspect(snapshot);
  assert.equal(actual.contentDurationMs, 212000);
  assert.equal(actual.nativeDurationMs, 211521);
  assert.equal(actual.clockUsable, true);
});

test('receipt preroll duration cannot become content duration or a lyric/audio clock', () => {
  // Duration/time come from the primary live receipt; the ad class is a test
  // fixture because that receipt did not capture #movie_player.className.
  const ad = media.inspect({ ...snapshot, mediaDurationSec: 15.421, mediaCurrentTimeSec: 4.41302, playerClassName: 'ad-showing playing-mode' });
  assert.equal(ad.contentDurationMs, 212000);
  assert.equal(ad.nativeDurationMs, 15421);
  assert.equal(ad.reason, 'YOUTUBE_AD_ACTIVE');
  assert.equal(ad.clockUsable, false);
  assert.equal(ad.paused, true);
  assert.equal(ad.seeking, true);
});

test('large duration mismatch gates transient ad state even without active class', () => {
  assert.equal(media.inspect({ ...snapshot, mediaDurationSec: 15.421 }).reason, 'YOUTUBE_MEDIA_DURATION_MISMATCH');
});

test('stale SPA metadata and absent main duration remain gated', () => {
  assert.equal(media.inspect({ ...snapshot, canonicalUrl: 'https://www.youtube.com/watch?v=FIXTURE0001' }).reason, 'YOUTUBE_METADATA_SOURCE_UNVERIFIED');
  assert.equal(media.inspect({ ...snapshot, isoDuration: undefined }).reason, 'YOUTUBE_CONTENT_DURATION_UNAVAILABLE');
});

test('ad-to-content transition restores gate only after native main metadata agrees', () => {
  const ad = { ...snapshot, playerClassName: 'ad-showing', mediaDurationSec: 15.421 };
  assert.equal(media.inspect(ad).clockUsable, false);
  assert.equal(media.inspect({ ...ad, playerClassName: 'playing-mode' }).clockUsable, false);
  assert.equal(media.inspect({ ...ad, playerClassName: 'playing-mode', mediaDurationSec: 211.521 }).clockUsable, true);
});

test('mobile YouTube watch identity binds to desktop canonical identity', () => {
  const mobile = media.inspect({ ...snapshot, url: 'https://m.youtube.com/watch?v=FIXTURE0003' });
  assert.equal(mobile.sourceVideoId, 'FIXTURE0003');
  assert.equal(mobile.metadataMatches, true);
  assert.equal(mobile.clockUsable, true);
});

test('catalog lookup uses verified native duration rather than rounded YouTube metadata', () => {
  const cinematic={...snapshot,url:'https://www.youtube.com/watch?v=FIXTURE0001',canonicalUrl:'https://www.youtube.com/watch?v=FIXTURE0001',isoDuration:'PT2M47S',mediaDurationSec:166.321};
  const live=media.inspect(cinematic);
  assert.equal(live.clockUsable,true);
  assert.equal(live.contentDurationMs,167000);
  assert.equal(live.lookupDurationMs,166321);
  const ad=media.inspect({...cinematic,playerClassName:'ad-showing',mediaDurationSec:15.421});
  assert.equal(ad.lookupDurationMs,167000);
  assert.equal(ad.clockUsable,false);
});

test('in-tab navigation with a stale duration tag uses the player display when it agrees with the media', () => {
  // Observed 2026-10-13: Sample Track after navigating from Tokens on the Desk in the same tab.
  const stale = { url: 'https://www.youtube.com/watch?v=FIXTURE0002', canonicalUrl: 'https://www.youtube.com/watch?v=FIXTURE0002', isoDuration: 'PT2M27S', playerClassName: 'html5-video-player ad-created paused-mode', mediaDurationSec: 134.901, mediaCurrentTimeSec: 2.03, playerDurationText: '2:14' };
  assert.equal(media.inspect({ ...stale, playerDurationText: undefined }).reason, 'YOUTUBE_MEDIA_DURATION_MISMATCH');
  const fixed = media.inspect(stale);
  assert.equal(fixed.clockUsable, true); assert.equal(fixed.contentDurationMs, 134000);
  // A disagreeing display, an active ad, or short media stays gated.
  assert.equal(media.inspect({ ...stale, playerDurationText: '2:27' }).clockUsable, false);
  assert.equal(media.inspect({ ...stale, playerClassName: 'ad-showing' }).reason, 'YOUTUBE_AD_ACTIVE');
  assert.equal(media.inspect({ ...stale, mediaDurationSec: 15.421, playerDurationText: '0:15' }).reason, 'YOUTUBE_MEDIA_DURATION_MISMATCH');
  assert.equal(media.parseClockMs('1:02:03'), 3723000); assert.equal(media.parseClockMs('abc'), null);
});
