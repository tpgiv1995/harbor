import React, { useCallback, useRef, useState } from 'react';
import './edit-save-status.css';

export function useRetainedAdds(key, mutate) {
  const [failed, setFailed] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(saved) ? saved.filter(item => item?.id && item.op?.type === 'task.add') : [];
    } catch { return []; }
  });
  const failedRef = useRef(failed);
  const active = useRef(new Map());
  const update = useCallback(change => {
    const next = change(failedRef.current);
    failedRef.current = next;
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* keep failed additions in memory */ }
    setFailed(next);
  }, [key]);
  // A submission creates an intention; only Retry reuses its persisted id.
  // getRandomValues is also available on the phone's plain HTTP origin.
  const add = useCallback((op, id = Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(36)).join('-')) => {
    if (active.current.has(id)) return active.current.get(id);
    const request = Promise.resolve().then(() => mutate(op)).then(result => {
      if (result?.ok) update(items => items.filter(item => item.id !== id));
      else if (result?.retryable) update(items => [...items.filter(item => item.id !== id), { id, op, reason: result.reason }]);
      return result;
    }).finally(() => active.current.delete(id));
    active.current.set(id, request);
    return request;
  }, [mutate, update]);
  return { add, failed, discard: id => update(items => items.filter(item => item.id !== id)) };
}

export function RetainedAdds({ add, failed, discard, onSaved }) {
  return failed.map(item => <div className="edit-save-status" role="status" key={item.id}>
    <span>&quot;{item.op.title}&quot; was not added: {item.reason || 'the store is busy'}</span>
    <button type="button" className="retry-add" onClick={async () => { if ((await add(item.op, item.id))?.ok) onSaved?.(item.op); }}>Retry add</button>
    <button type="button" onClick={() => discard(item.id)}>Discard</button>
  </div>);
}
