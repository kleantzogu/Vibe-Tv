'use strict';
/*
 * Menus on Android. On a computer `api.popupMenu` opens a native context menu; here it is a sheet
 * that slides up from the bottom of the page, with rows large enough for a finger (and, being
 * buttons, reachable with a remote). Same items, same answer: the chosen item's id, or null.
 */

function createMenu(document) {
  let open = null; // { back, done }

  function close(id = null) {
    if (!open) return false;
    const { back, done, from } = open;
    open = null;
    back.remove();
    if (from && from.focus && from.isConnected !== false) from.focus({ preventScroll: true }); // back to where the remote was
    done(id);
    return true;
  }

  /** @param {Array<{ id, label, enabled?, checked? } | { type: 'separator' }>} items */
  function show(items) {
    close();
    return new Promise((done) => {
      const back = document.createElement('div');
      back.className = 'sheet-back';
      const sheet = document.createElement('div');
      sheet.className = 'sheet';
      sheet.setAttribute('role', 'menu');
      const checks = (items || []).some((it) => typeof it.checked === 'boolean');
      let first = null;
      for (const it of items || []) {
        if (it.type === 'separator') {
          const sep = document.createElement('div');
          sep.className = 'sheet-sep';
          sheet.appendChild(sep);
          continue;
        }
        const b = document.createElement('button');
        b.className = 'sheet-item';
        b.setAttribute('role', typeof it.checked === 'boolean' ? 'menuitemcheckbox' : 'menuitem');
        if (typeof it.checked === 'boolean') b.setAttribute('aria-checked', String(it.checked));
        if (it.enabled === false) b.disabled = true;
        if (checks) {
          const mark = document.createElement('span');
          mark.className = 'sheet-check';
          mark.textContent = it.checked ? '✓' : '';
          b.appendChild(mark);
        }
        const label = document.createElement('span');
        label.textContent = String(it.label);
        b.appendChild(label);
        b.addEventListener('click', () => close(it.id));
        sheet.appendChild(b);
        if (!first && !b.disabled) first = b;
      }
      back.appendChild(sheet);
      back.addEventListener('click', (e) => { if (e.target === back) close(); });
      const from = document.activeElement;
      document.body.appendChild(back);
      open = { back, done, from };
      if (first && first.focus) first.focus({ preventScroll: true });
    });
  }

  return { show, close, isOpen: () => !!open };
}

module.exports = { createMenu };
