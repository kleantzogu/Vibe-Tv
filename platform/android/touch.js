'use strict';
/*
 * How the player answers a finger.
 *
 * With a mouse, moving over the picture shows the controls and a click pauses. A finger has no
 * "moving over": the first tap would pause the channel just to reveal the controls. So on a touch
 * screen a tap on the picture shows or hides the controls and never pauses (the pause button does),
 * and dragging the picture does nothing (on a computer it moves the window). A double tap still
 * goes full screen, as a double-click does.
 *
 * It listens on the same element as the app, and is installed first, so it sees each event first.
 */
function installTouch({ video, playerEl }) {
  const isTouch = (e) => e.pointerType === 'touch';
  let down = null;

  video.addEventListener('pointerdown', (e) => {
    if (!isTouch(e)) return;
    e.stopImmediatePropagation();
    down = { id: e.pointerId, x: e.clientX, y: e.clientY };
  });
  video.addEventListener('pointermove', (e) => {
    if (isTouch(e)) e.stopImmediatePropagation();
  });
  video.addEventListener('pointercancel', (e) => {
    if (isTouch(e)) down = null;
  });
  video.addEventListener('pointerup', (e) => {
    if (!isTouch(e)) return;
    e.stopImmediatePropagation();
    const tap = down && down.id === e.pointerId && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 12;
    down = null;
    if (!tap || playerEl.classList.contains('idle')) return;
    if (playerEl.classList.contains('controls-hidden')) {
      playerEl.dispatchEvent(new Event('mousemove')); // what the app shows its controls on
    } else if (!playerEl.classList.contains('paused')) {
      playerEl.classList.add('controls-hidden');
      hiddenAt = Date.now();
    }
  });
  // After a tap the browser also sends the mouse events a mouse would have made. The "mouse moved"
  // among them would bring back the controls the tap has just hidden.
  let hiddenAt = 0;
  playerEl.addEventListener('mousemove', (e) => {
    if (e.isTrusted && Date.now() - hiddenAt < 700) e.stopImmediatePropagation();
  });
}

module.exports = { installTouch };
