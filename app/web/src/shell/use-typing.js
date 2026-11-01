import { useEffect, useState } from 'react';

// TYPING IS FOCUS PLUS A KEYBOARD THAT IS ACTUALLY UP (2026-10-21, Pat: "if i
// try to type anything then the keyboard takes up the other half of the screen
// so i cant see a single line of my actual text"). While it holds, the shell
// drops what a person typing does not need (the bottom tabs, the header's
// second row, the home-bar inset the keyboard already covers), so the box being
// typed in and the conversation above it get the screen.
//
// Focus is the intent. The keyboard is read against the TALLEST visible height
// seen at this width, never against innerHeight: standalone Safari may resize
// both viewports, so their difference says nothing (see use-visual-viewport.js),
// but a visible area well below what this same screen showed a moment ago does.
// That is what brings the tabs back when a hardware keyboard needs no room, or
// when the keyboard goes away while the field keeps focus (both caught in the
// second adversarial review, where focus alone left the tabs hidden).
//
// Focus moving onto the composer's own controls (Send, the plus) is still
// typing: treating it as leaving brought the tabs back mid-tap, the layout
// jumped 90px under the finger, and the first tap on Send was lost.
const EDITABLE = [
  'textarea',
  'input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]):not([type="button"]):not([type="submit"]):not([type="reset"])',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  // The message box (composer/plain-text.cjs). Missing it here kept the tabs up
  // while typing, the exact screen loss this hook exists to prevent.
  '[contenteditable="plaintext-only"]',
].join(', ');
// A visible area this much shorter than the tallest seen is a keyboard; the
// iOS accessory bar alone, or a URL bar settling, is far less.
const KEYBOARD_MIN_PX = 150;

export function isEditable(element) {
  return Boolean(element && typeof element.matches === 'function' && element.matches(EDITABLE)
    && !element.disabled && !element.readOnly);
}

function visibleSize() {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  return {
    height: vv?.height ?? (typeof window !== 'undefined' ? window.innerHeight : 0),
    width: Math.round(vv?.width ?? (typeof window !== 'undefined' ? window.innerWidth : 0)),
  };
}

export function useTyping(scopeRef) {
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    let timer = null;
    let tallest = 0;
    let tallestWidth = 0;
    let composing = false; // focus is in a field, or on the composer's own controls
    const measure = () => {
      const { height, width } = visibleSize();
      // A rotation is a new screen: start its tallest over.
      if (width !== tallestWidth) { tallestWidth = width; tallest = height; }
      tallest = Math.max(tallest, height);
      return tallest - height >= KEYBOARD_MIN_PX;
    };
    const publish = () => setTyping(composing && measure());
    const check = () => {
      const active = document.activeElement;
      const scope = scopeRef?.current || null;
      const inScope = !scope || (active && scope.contains(active));
      composing = Boolean(inScope && (isEditable(active) || (composing && active?.closest?.('.composer'))));
      publish();
    };
    // focusout fires while the old element still holds focus; read the new one
    // after it lands, or a tap from one field to the next flickers the tabs.
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(check, 0);
    };
    const vv = window.visualViewport;
    document.addEventListener('focusin', check);
    document.addEventListener('focusout', later);
    vv?.addEventListener('resize', publish);
    window.addEventListener('resize', publish);
    check();
    return () => {
      clearTimeout(timer);
      document.removeEventListener('focusin', check);
      document.removeEventListener('focusout', later);
      vv?.removeEventListener('resize', publish);
      window.removeEventListener('resize', publish);
    };
  }, [scopeRef]);
  return typing;
}
