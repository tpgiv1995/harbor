'use strict';

// THE SCREEN READS A SEND ENGINE NEEDS, BUILT ONCE FOR EVERY COMPOSITION ROOT
// (2026-11-20, Pat from the phone: "Text me latest PDFs please" refused three
// times with "Claude's prompt already has text or an attachment in it").
// The desktop (main/index.js) and the phone server (server/compose.js) each
// build their own createSessionSend, and each used to spell these reads out by
// hand. The desktop passed readSuggestion; the phone server never did, so its
// send engine fell back to "no suggestion" and read Claude's DIM predicted
// prompt ("change the comments to say as we discussed", drawn after an idle
// compaction) as someone's typed draft. promptDraft then refused every text,
// picture and slash send from the phone while the desktop typed over the same
// box. Only the keeper's modeled cells can tell dim from typed (see
// src/daemon/screen.js composerSuggestion), so the suggestion read is part of
// the same contract as the text read, and both roots take all three from here.
function daemonSendReads(client) {
  return {
    snapshot: async () => {
      const res = await client.snapshot();
      return res?.snapshot || res || {};
    },
    readPane: async (paneId, lines = 16, source = 'recent') => {
      const res = await client.readPane(paneId, { source, lines, strip_ansi: true });
      return res?.read?.text || '';
    },
    readSuggestion: async (paneId) => {
      const res = await client.readPane(paneId, { source: 'visible', lines: 1 });
      return res?.screen?.suggestion || null;
    },
  };
}

module.exports = { daemonSendReads };
