(function (root) {
  'use strict';
  // Own only the temporary setting we changed. A human toggle takes precedence.
  async function begin(toggle, media) {
    const current = toggle?.getAttribute('aria-checked');
    if (!media || !toggle || !['true', 'false'].includes(current)) throw Object.assign(new Error('YouTube autoplay control is unavailable; whole-song alignment did not start.'), { code: 'AUTOPLAY_GUARD_UNAVAILABLE' });
    let userChanged = false, released = false;
    const userInput = event => { if (event.isTrusted && (event.type !== 'keydown' || event.key === 'Enter' || event.key === ' ')) userChanged = true; };
    toggle.addEventListener('pointerdown', userInput, true);
    toggle.addEventListener('keydown', userInput, true);
    const changed = current === 'true';
    if (changed) {
      toggle.click();
      for (let i = 0; i < 20 && toggle.getAttribute('aria-checked') !== 'false'; i++) await new Promise(resolve => setTimeout(resolve, 50));
      if (toggle.getAttribute('aria-checked') !== 'false') {
        toggle.removeEventListener('pointerdown', userInput, true); toggle.removeEventListener('keydown', userInput, true);
        throw Object.assign(new Error('YouTube autoplay could not be turned off; whole-song alignment did not start.'), { code: 'AUTOPLAY_GUARD_UNAVAILABLE' });
      }
    }
    function hold(sameMedia = true) {
      if (!sameMedia) return;
      media.pause();
      // An ended YouTube player can start its countdown if autoplay is restored.
      if (media.ended && Number.isFinite(media.duration)) media.currentTime = Math.max(0, media.duration - .15);
    }
    return {
      valid() { return !userChanged && toggle.isConnected && toggle.getAttribute('aria-checked') === 'false'; },
      hold,
      release({ completed = false, sameMedia = true } = {}) {
        if (released) return; released = true;
        if (completed) hold(sameMedia);
        toggle.removeEventListener('pointerdown', userInput, true); toggle.removeEventListener('keydown', userInput, true);
        if (changed && !userChanged && toggle.isConnected && toggle.getAttribute('aria-checked') === 'false') toggle.click();
      },
    };
  }
  root.LvAutoplayGuard = { begin };
  if (typeof module !== 'undefined') module.exports = root.LvAutoplayGuard;
})(globalThis);
