# DESIGN.md

How the Vibe TV interface is built, for desktop, phone and TV. Read with [AGENTS.md](AGENTS.md).

## Principles

- **The picture comes first.** The interface is quiet: system font, neutral surfaces, one accent
  colour. Nothing decorative competes with the video.
- **It looks like it belongs on the device.** The system's accent colour, light and dark from the
  system, native menus on a computer, bottom sheets on a phone, a clear focus on a TV.
- **One design, three sizes.** A component is designed once in `src/styles.css` and resized per
  platform. It is never redesigned per platform.

## Where styles go

| What | File | Scope |
| --- | --- | --- |
| Every component, and the desktop sizes | `src/styles.css` | unscoped |
| macOS / Windows / Linux differences | `src/styles.css` | `.platform-darwin`, `.platform-win32`, `.platform-linux` |
| Phone and tablet | `platform/android/android.css` | `.platform-android` |
| TV | `platform/android/android.css` | `.platform-androidtv` |
| Things only Android has (sheets, native player) | `platform/android/android.css` | unscoped |

The class is on `<html>` and is set at startup by `app.js`.

- A platform rule only changes **size, spacing, visibility and layout**. If it changes how a component
  looks or is built, fix the component in `src/styles.css`.
- When you add or restyle a component in `src/styles.css`, check `android.css` for rules on the same
  selectors and update them in the same change. Renaming a class or an id means searching
  `platform/android/` too (`android.css`, `tv-focus.js`, `touch.js`, `menu.js` refer to them).
- No inline styles for anything that could be a class, and no new stylesheet.

## Tokens

Colours, the font, row height and radius are CSS variables in `:root` at the top of `src/styles.css`.

- **Never write a colour directly in a rule.** Use a token: `--window`, `--sidebar`, `--pane`
  (surfaces); `--text`, `--text-2`, `--text-3` (text, strongest to faintest); `--line`, `--field`,
  `--field-line`, `--tile` (edges and fills); `--hover`, `--press` (states); `--accent`, `--on-accent`;
  `--online`, `--offline`; `--shadow`. The exception is what sits on the video (controls, notes),
  which is white on translucent black in both modes.
- **A new colour token gets a light and a dark value** (the `prefers-color-scheme: dark` block).
- `--accent` is replaced by the system accent colour at startup: never assume it is blue, and put
  only `--on-accent` on top of it.
- Use `--radius` and `--row-h` instead of repeating their numbers. `--row-h` must match `ROW_H` in
  `app.js` (the list is virtual and positions rows itself).
- If a new size would have to be overridden for both phone and TV, make it a token and override the
  token, not each rule.

## Every interactive element

1. **Is a `<button>`, an `<input>`, or has `tabindex="0"`.** Anything else cannot be reached with a
   keyboard or a remote (`tv-focus.js` looks for exactly these).
2. **Shows focus.** Keep the `:focus-visible` outline; if you remove it, replace it with something as
   visible. On video, the focus is white.
3. **Never depends on hover.** Hover may reveal a shortcut on a computer, but the same action must be
   reachable without a pointer: visible on phone and TV, or in the row's menu.
4. **Has a label.** Icon-only buttons carry an `aria-label` and a `title`; icons are
   `aria-hidden` (the `svg()` helper in `app.js` does this).
5. **Has all its states:** hover (`--hover`), pressed (`--press`), focused, disabled, and "on" where
   it toggles.

## Per platform

**Desktop**: pointer and keyboard. Body text 13px, rows 60px. The window can be dragged by the top
strip and the sidebar resized. A new action also gets a keyboard shortcut and a menu entry where one
would be expected; show shortcuts as `⌘` on a Mac and `Ctrl+` elsewhere.

**Phone and tablet**: finger.
- Touch targets at least 40px, 44px or more for primary actions.
- Text fields 16px or larger.
- A tap on the picture shows or hides the controls and never pauses; a long-press on a channel opens
  its menu; Back closes whatever is open. Menus are bottom sheets (`menu.js`), not pop-ups.
- Works held upright (picture on top, list below) and sideways (list beside the picture).
- No window dragging, sidebar resizing or volume slider.

**TV**: remote only: four arrows, OK, Back.
- Something always has the focus, and an arrow must be able to reach every control on screen. Lay
  controls out in clear rows and columns so "the nearest thing in that direction" is the expected one.
- Opening a dialog, sheet or menu moves the focus into it; closing it returns the focus to where it was.
  Back closes the topmost thing.
- Keep a margin from the screen edge (`3vh 3vw`), because some TVs cut off their edges. Full-screen
  video is the exception.
- Type and controls are larger than on desktop; the focus ring is 3px.
- Text fields are read-only stops: OK opens the system's own text dialog. Do not build anything that
  needs typing in place, dragging, hovering, or picking a file.
- A new screen or control flow is added to the key map described at the top of `tv-focus.js`.

## Light, dark and motion

- Both modes follow the system (`prefers-color-scheme`); there is no theme switch. Check every
  visible change in both.
- Animation is short and has a purpose (something appearing, moving or loading). Every animation has
  a `prefers-reduced-motion: reduce` rule that removes or slows it.

## Words

Short and plain, in sentence case, saying what happened and what to do next: "No sound: this device
can't play AC-3 audio". No jargon the user did not type themselves, no exclamation marks, no blame.
Never show a stream address or login in a message, because they contain the user's password.

## Before you finish

- [ ] The change is in `src/`, and `android.css` only resizes, hides or rearranges it.
- [ ] No colour written directly; new tokens have light and dark values.
- [ ] Reachable and usable with the keyboard alone, and with arrows + OK + Back alone.
- [ ] Nothing important is hover-only.
- [ ] Looked at on desktop (light and dark), phone (portrait and landscape) and TV, or said which were not.
- [ ] `npm test` passes.
