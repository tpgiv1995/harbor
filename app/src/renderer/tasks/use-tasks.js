import { useCallback, useEffect, useRef, useState } from 'react';
import tasksModel from '../../shared/tasks-model.cjs';

const { dayKey, msUntilDayRoll } = tasksModel;

/**
 * The renderer's window onto the task document.
 *
 * Main owns the file and the reducer runs on BOTH sides of the wire, so this
 * never invents state: it holds whatever main last confirmed, and every
 * mutation round-trips before the UI believes it. A refused operation surfaces
 * its reason instead of silently doing nothing, because a click that appears to
 * work and does not is exactly the failure this app keeps being burned by.
 */
export function useTasks() {
  const [doc, setDoc] = useState(null);
  const [recovery, setRecovery] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    let live = true;
    window.harbor.tasks.read()
      .then((result) => {
        if (!live) return;
        if (result?.ok) {
          setDoc(result.doc);
          setRecovery(result.recovery || null);
          setError(null);
        } else setError('the task file could not be read');
      })
      .catch((e) => { if (live) setError(String(e?.message || e)); });
    // An edit made outside Harbor repaints here rather than being clobbered by
    // the next mutation.
    const off = window.harbor.tasks.onChange((payload) => {
      if (live && payload?.doc) setDoc(payload.doc);
    });
    return () => { live = false; off?.(); };
  }, []);

  const mutate = useCallback(async (op) => {
    const result = await window.harbor.tasks.mutate(op)
      .catch((e) => ({ ok: false, reason: String(e?.message || e) }));
    if (result?.doc) setDoc(result.doc);
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

/**
 * Today's day key, kept current while the app is open.
 *
 * Harbor stays running for days at a time, so a day key read once at mount goes
 * stale and My Day would keep showing yesterday's list. This wakes exactly at
 * the roll instead of polling.
 */
export function useToday() {
  const [today, setToday] = useState(() => dayKey());
  const timerRef = useRef(null);

  useEffect(() => {
    let live = true;
    const schedule = () => {
      clearTimeout(timerRef.current);
      // +1s so the timer never fires a hair EARLY and computes the old key,
      // which would reschedule a zero-length timeout and spin.
      timerRef.current = setTimeout(() => {
        if (!live) return;
        setToday(dayKey());
        schedule();
      }, msUntilDayRoll() + 1000);
    };
    schedule();
    // A laptop that suspends through the roll wakes with a timer that has not
    // fired yet; re-checking on focus catches that without a poll.
    const onFocus = () => setToday(dayKey());
    window.addEventListener('focus', onFocus);
    return () => {
      live = false;
      clearTimeout(timerRef.current);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  return today;
}
