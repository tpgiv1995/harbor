'use strict';

async function openKeyboard(page) {
  const input = page.getByLabel('Message', { exact: true });
  await input.focus();
  await page.evaluate(() => window.__harborOpenKeyboard());
  await page.waitForFunction(() => getComputedStyle(document.documentElement)
    .getPropertyValue('--app-h').trim() === '546px');
  await page.waitForTimeout(100);
}

async function geometry(page) {
  return page.evaluate(() => {
    const rect = (selector) => {
      const box = document.querySelector(selector)?.getBoundingClientRect();
      return box ? { top: box.top, right: box.right, bottom: box.bottom, left: box.left } : null;
    };
    const visibleFixed = [...document.querySelectorAll('body *')]
      .filter((el) => {
        const style = getComputedStyle(el);
        return style.position === 'fixed' && style.display !== 'none'
          && style.visibility !== 'hidden' && style.pointerEvents !== 'none'
          && el.getAttribute('aria-hidden') !== 'true'
          && !el.closest('[aria-hidden="true"]') && el.getClientRects().length;
      })
      .map((el) => ({ el: el.className || el.tagName, box: el.getBoundingClientRect() }));
    const overlaps = [];
    for (let i = 0; i < visibleFixed.length; i += 1) {
      for (let j = i + 1; j < visibleFixed.length; j += 1) {
        const a = visibleFixed[i];
        const b = visibleFixed[j];
        if (Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left) > 1
          && Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top) > 1) {
          overlaps.push([String(a.el), String(b.el)]);
        }
      }
    }
    const last = document.querySelector('.conv-body > :last-child');
    const lastBox = last?.getBoundingClientRect() || null;
    return {
      innerHeight: window.innerHeight,
      visualHeight: window.visualViewport.height,
      visualTop: window.visualViewport.offsetTop,
      visualBottom: window.visualViewport.offsetTop + window.visualViewport.height,
      shell: rect('.app-shell'),
      composer: rect('.composer'),
      textarea: rect('textarea[aria-label="Message"]'),
      send: rect('button[aria-label="Send"]'),
      lastBlock: lastBox ? { top: lastBox.top, bottom: lastBox.bottom } : null,
      fixedOverlaps: overlaps,
    };
  });
}

function registerMobileKeyboardSpecs({
  test, expect, makeUiFixture, launchPhone, closeUi, screenshotPath,
}) {
  test.describe('MOBILE-KEYBOARD-1 real-trace geometry gate', () => {
    async function drive(assertion) {
      const fx = await makeUiFixture();
      let electronApp;
      try {
        ({ electronApp, page: fx.page } = await launchPhone(fx, { keyboard: true }));
        await openKeyboard(fx.page);
        const measured = await geometry(fx.page);
        await assertion(measured, fx.page);
        return measured;
      } finally {
        await closeUi(fx, electronApp);
      }
    }

    test('shell and composer follow the observed visual viewport rectangle', async () => {
      const measured = await drive(
        async (m) => {
          expect(m.innerHeight).toBe(548);
          expect(m.visualHeight).toBe(546);
          expect(m.visualTop).toBe(325);
          expect(m.shell.top, JSON.stringify(m)).toBeGreaterThanOrEqual(m.visualTop);
          expect(m.shell.bottom, JSON.stringify(m)).toBeLessThanOrEqual(m.visualBottom + 1);
          expect(m.composer.top, JSON.stringify(m)).toBeGreaterThanOrEqual(m.visualTop);
          expect(m.composer.bottom, JSON.stringify(m)).toBeLessThanOrEqual(m.visualBottom + 1);
        },
      );
      expect(measured.composer).toBeTruthy();
    });

    test('textarea never intersects the simulated keyboard rectangle', async () => {
      await drive(
        async (m) => {
          expect(m.textarea.bottom, JSON.stringify(m)).toBeLessThanOrEqual(m.visualBottom + 1);
          expect(m.send.bottom, JSON.stringify(m)).toBeLessThanOrEqual(m.visualBottom + 1);
        },
      );
    });

    test('last conversation block remains visible above the composer', async () => {
      await drive(
        async (m) => {
          expect(m.lastBlock, JSON.stringify(m)).toBeTruthy();
          expect(m.lastBlock.bottom, JSON.stringify(m)).toBeLessThanOrEqual(m.composer.top + 1);
          expect(m.lastBlock.bottom, JSON.stringify(m)).toBeGreaterThan(m.visualTop);
        },
      );
    });

    test('keyboard state never leaves two fixed bars overlapping', async () => {
      await drive(
        async (m) => expect(m.fixedOverlaps, JSON.stringify(m)).toEqual([]),
      );
    });

    test('keyboard reflow never makes the document itself scrollable', async () => {
      await drive(
        async (m, page) => {
          // Ask whether the document CAN scroll, by trying to scroll it. The
          // original assertion here compared scrollHeight against
          // visualViewport.height, which is not the same question: with
          // overflow:hidden the content box legitimately exceeds the viewport
          // while the document is pinned, so that check failed against a
          // correctly reflowed app. Behaviour is unambiguous where a
          // measurement was not.
          const documentMoved = await page.evaluate(() => {
            const before = { w: window.scrollY, d: document.documentElement.scrollTop };
            window.scrollTo(0, 600);
            document.documentElement.scrollTop = 600;
            const moved = window.scrollY !== before.w
              || document.documentElement.scrollTop !== before.d;
            window.scrollTo(0, before.w);
            document.documentElement.scrollTop = before.d;
            return moved;
          });
          expect(documentMoved, JSON.stringify(m)).toBe(false);
        },
      );
    });
  });
}

module.exports = { registerMobileKeyboardSpecs };
