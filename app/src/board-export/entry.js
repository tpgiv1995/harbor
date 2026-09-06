// Self-contained board-export bundle. vite resolves every bare specifier the
// Excalidraw prod ESM carries (react, jotai, roughjs/bin/rough, open-color,
// @excalidraw/laser-pointer, ...) at BUILD time, which is what a Blink page
// can never do at runtime without an import map: the pre-vite shape of board
// export dynamic-imported the prod ESM into a blank page and died on exactly
// those specifiers. The runner (board-export-runner.cjs) loads the built page
// into a hidden BrowserWindow and calls this API.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Excalidraw, exportToBlob, FONT_FAMILY } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';

const FAMILY_NAME = Object.fromEntries(
  Object.entries(FONT_FAMILY).map(([name, id]) => [id, name]),
);

// Excalidraw registers its content FontFaces only from a MOUNTED component:
// measured in the live export page, document.fonts.size is 0 after a bare
// module import, and exportToBlob then measures every label with fallback
// metrics, wrapping and clipping the text (the probe sticky rendered its
// centred label half off the bottom edge). So the page mounts a real App on
// the scene first, the same environment the Board view's own Copy PNG has,
// then explicitly loads each text element's family with its own characters so
// the right unicode-range subset faces are in before anything measures.
async function prepareFonts(scene) {
  const host = document.getElementById('root');
  const root = createRoot(host);
  await new Promise((resolve) => {
    root.render(React.createElement(Excalidraw, {
      excalidrawAPI: () => resolve(),
      initialData: {
        elements: scene.elements,
        files: scene.files,
      },
    }));
  });
  const deadline = Date.now() + 15000;
  while (document.fonts.size === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const loads = [];
  for (const el of scene.elements || []) {
    if (!el || el.isDeleted || el.type !== 'text') continue;
    const family = FAMILY_NAME[el.fontFamily] || 'Excalifont';
    const sample = `${el.originalText || el.text || ''}Mg`;
    loads.push(document.fonts.load(`${el.fontSize || 20}px "${family}"`, sample));
  }
  await Promise.allSettled(loads);
  await document.fonts.ready;
}

window.__harborBoardExport = { exportToBlob, prepareFonts };
