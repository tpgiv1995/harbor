import { useCallback, useEffect, useRef, useState } from 'react';
import fileDrop from './stage/file-drop.cjs';

const {
  dragCarriesFiles, splitDroppedFiles, fileAttachmentsFromPaths, imageAttachment,
  imageExtension, dropPrompt, dropReport,
} = fileDrop;

// How long the app waits without a dragover before deciding the pointer left.
// dragleave fires on every child boundary, so a counter drifts; a heartbeat
// does not.
const DRAG_IDLE_MS = 420;
const REPORT_MS = 3200;

function readAsDataUri(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

// The whole window is the landing zone (Pat, 2026-07-25). Two jobs, in this
// order of importance:
//   1. NOTHING dropped on Harbor may ever navigate the window. Chromium's
//      default for a dropped file is to open it, which blanked the app and is
//      the likeliest cause of the window Pat lost. Every dragover/drop is
//      preventDefault'd at the window, handled or not.
//   2. Images and other files attach to the SELECTED session's draft as chips.
export function useFileDrop({ sessionId, sessionTitle, getDraft, patchDraft }) {
  const [active, setActive] = useState(false);
  const [report, setReport] = useState(null);
  const lastDragRef = useRef(0);
  const targetRef = useRef({ sessionId, getDraft, patchDraft });
  targetRef.current = { sessionId, getDraft, patchDraft };

  const handleFiles = useCallback(async (files) => {
    const { sessionId: id, getDraft: read, patchDraft: patch } = targetRef.current;
    if (!id) {
      setReport('No session selected, nothing was attached');
      return;
    }
    const { images, others } = splitDroppedFiles(files);
    const attachments = [];
    let unresolved = 0;

    for (const file of images) {
      try {
        const buffer = await file.arrayBuffer();
        const savedPath = await window.harbor.clipboard
          .saveImage({ buffer, ext: imageExtension(file) })
          .catch(() => null);
        if (!savedPath) { unresolved += 1; continue; }
        attachments.push(imageAttachment(savedPath, await readAsDataUri(file)));
      } catch {
        unresolved += 1;
      }
    }

    const paths = [];
    for (const file of others) {
      const path = window.harbor.files?.pathFor?.(file) || '';
      if (path) paths.push(path); else unresolved += 1;
    }

    const fileAttachments = fileAttachmentsFromPaths(paths);
    if (attachments.length || fileAttachments.length) {
      // Read the draft at DROP time and patch that session by id: the drop may
      // land while the selection is changing, and a stale closure would write
      // one session's files into another's draft.
      const current = read(id);
      patch(id, {
        attachments: [
          ...(Array.isArray(current?.attachments) ? current.attachments : []),
          ...attachments,
          ...fileAttachments,
        ],
      });
    }
    setReport(dropReport({ images: attachments.length, files: fileAttachments.length, unresolved }));
  }, []);

  useEffect(() => {
    const onDragOver = (event) => {
      if (!dragCarriesFiles(event.dataTransfer?.types)) return;
      if (event.target?.closest?.('.excalidraw')) return;
      // Both are required: without preventDefault on dragover the drop event
      // never fires AND the browser keeps its own default.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      lastDragRef.current = Date.now();
      setActive(true);
    };
    const onDrop = (event) => {
      if (event.target?.closest?.('.excalidraw')) return;
      // Unconditional: even a drag we do not decorate must not navigate.
      event.preventDefault();
      setActive(false);
      const files = event.dataTransfer?.files;
      if (files?.length) handleFiles(files);
    };
    const onDragEnd = () => setActive(false);
    // CAPTURE phase, deliberately. Children handle drops of their own (xterm
    // pastes a dropped path into the pty), and a child that stops propagation
    // would both steal the file and leave the navigation default in place. The
    // landing zone is the whole app, so the app decides first.
    window.addEventListener('dragover', onDragOver, true);
    window.addEventListener('drop', onDrop, true);
    window.addEventListener('dragend', onDragEnd, true);
    const idle = setInterval(() => {
      if (lastDragRef.current && Date.now() - lastDragRef.current > DRAG_IDLE_MS) setActive(false);
    }, 200);
    return () => {
      window.removeEventListener('dragover', onDragOver, true);
      window.removeEventListener('drop', onDrop, true);
      window.removeEventListener('dragend', onDragEnd, true);
      clearInterval(idle);
    };
  }, [handleFiles]);

  useEffect(() => {
    if (!report) return undefined;
    const timer = setTimeout(() => setReport(null), REPORT_MS);
    return () => clearTimeout(timer);
  }, [report]);

  return {
    active,
    report,
    prompt: dropPrompt({ sessionTitle, hasSession: Boolean(sessionId) }),
  };
}
