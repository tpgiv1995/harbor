import { useCallback, useEffect, useState } from 'react';

export function useNotes() {
  const [doc, setDoc] = useState(null);
  const [recovery, setRecovery] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    let live = true;
    window.harbor.notes.read()
      .then((result) => {
        if (!live) return;
        if (result?.ok) {
          setDoc(result.doc);
          setRecovery(result.recovery || null);
          setError(null);
        } else setError('the notes file could not be read');
      })
      .catch((e) => { if (live) setError(String(e?.message || e)); });
    const off = window.harbor.notes.onChange((payload) => {
      if (live && payload?.doc) setDoc(payload.doc);
    });
    return () => { live = false; off?.(); };
  }, []);

  const mutate = useCallback(async (op) => {
    const result = await window.harbor.notes.mutate(op)
      .catch((e) => ({ ok: false, reason: String(e?.message || e) }));
    // A refusal keeps the doc on screen: a transiently unreadable file answers
    // with the fallback near-empty doc, and rendering THAT would swap a full
    // notes list for an empty one until the next outside event.
    if (result?.ok && result.doc) setDoc(result.doc);
    if (result?.recovery !== undefined) setRecovery(result.recovery || null);
    setNotice(result?.ok ? null : (result?.reason || 'that change did not save'));
    return result || { ok: false };
  }, []);

  return {
    doc,
    recovery,
    error,
    notice,
    dismissNotice: useCallback(() => setNotice(null), []),
    mutate,
  };
}
