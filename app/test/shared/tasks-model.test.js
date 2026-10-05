'use strict';

// The task reducer. Everything the Tasks view can do goes through applyOp, and
// everything it can SHOW goes through selectRows, so this file is where the
// behaviour is actually pinned; the React tree only draws what these return.
//
// The cases that matter most are the ones where a wrong answer quietly destroys
// something the user typed: the completion cascade (spec 4/5), the parent-graph
// repair (spec 9), and the day roll (spec 6/7), where an off-by-one timezone
// would empty My Day while they were still working.

const test = require('node:test');
const assert = require('node:assert/strict');

const model = require('../../src/shared/tasks-model.cjs');

const {
  MAX_DEPTH, applyOp, counts, dayKey, dueState, emptyDoc, isMyDay,
  normalizeDoc, selectRows, shiftDay, tagIndex,
} = model;

// Deterministic ids so a failure names the task it broke on.
function seededIds() {
  let n = 0;
  return (prefix = 't') => { n += 1; return `${prefix}${n}`; };
}

const AT = Date.parse('2026-07-30T14:00:00');
const TODAY = dayKey(new Date(AT));

function fresh() {
  return { doc: emptyDoc(AT), ids: seededIds() };
}

function add(doc, fields, ids, now = AT) {
  const result = applyOp(doc, { type: 'task.add', ...fields }, { now, idFactory: ids });
  assert.equal(result.ok, true, result.reason);
  return { doc: result.doc, id: result.taskId };
}

function find(doc, id) {
  return doc.tasks.find((t) => t.id === id);
}

test('1) a new document has one list and no tasks', () => {
  const { doc } = fresh();
  assert.equal(doc.lists.length, 1);
  assert.equal(doc.lists[0].name, 'Tasks');
  assert.deepEqual(doc.tasks, []);
  assert.equal(doc.version, model.DOC_VERSION);
});

test('1b) the seeded list keeps the SAME id on every read, so a fresh install can rename it', () => {
  // Live-caught while driving the real app: a generated seed id is a different
  // id on every normalise, so the very first thing a new user might do (rename
  // "Tasks" to something of their own) was refused as "that list no longer
  // exists" because the id they were holding had never been written down.
  assert.equal(emptyDoc(AT).lists[0].id, model.DEFAULT_LIST_ID);
  assert.equal(normalizeDoc({}, { now: AT }).lists[0].id, model.DEFAULT_LIST_ID);
  assert.equal(normalizeDoc(null, { now: AT }).lists[0].id, model.DEFAULT_LIST_ID);

  const held = emptyDoc(AT).lists[0].id;
  const renamed = applyOp(emptyDoc(AT), { type: 'list.rename', listId: held, name: 'Personal' }, { now: AT });
  assert.equal(renamed.ok, true, renamed.reason);
  assert.equal(renamed.doc.lists[0].name, 'Personal');
});

test('1c) an entry with no id of its own is flagged, so the store can make the minted id real', () => {
  assert.equal(model.mintsIds({ lists: [{ id: 'L1' }], tasks: [{ id: 't1', title: 'a' }] }), false);
  assert.equal(model.mintsIds({ tasks: [{ title: 'typed in by hand' }] }), true);
  assert.equal(model.mintsIds({ lists: [{ name: 'no id' }] }), true);
  assert.equal(model.mintsIds({ tasks: [{ id: '   ', title: 'blank id' }] }), true);
  assert.equal(model.mintsIds(null), false);
  assert.equal(model.mintsIds({}), false);
});

test('an assignment annotation appends the minted session id without replacing the note', () => {
  const { doc, ids } = fresh();
  const added = add(doc, { title: 'Delegate me', notes: 'Pat note' }, ids);
  const result = applyOp(added.doc, {
    type: 'task.appendAssignment', taskId: added.id, sessionId: 'session-123',
  }, { now: AT });
  assert.equal(result.ok, true, result.reason);
  assert.equal(find(result.doc, added.id).notes, `Pat note\nAssigned to Claude session session-123 at ${new Date(AT).toISOString()}`);
});

test('2) adding a task fills every field the UI reads, and a nameless one is refused', () => {
  const { doc, ids } = fresh();
  const listId = doc.lists[0].id;
  const added = add(doc, { listId, title: '  Call Brian about the sweep  ' }, ids);
  const task = find(added.doc, added.id);
  assert.equal(task.title, 'Call Brian about the sweep', 'title is trimmed');
  assert.equal(task.listId, listId);
  assert.equal(task.parentId, null);
  assert.equal(task.depth, 0);
  assert.equal(task.done, false);
  assert.equal(task.starred, false);
  assert.equal(task.myDayDate, null);
  assert.equal(task.dueDate, null);
  assert.deepEqual(task.tags, []);
  assert.equal(task.createdAt, AT);
  assert.equal(task.updatedAt, AT);
  assert.equal(task.completedAt, null);

  const refused = applyOp(added.doc, { type: 'task.add', listId, title: '   ' }, { now: AT });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /needs a name/);
});

test('3) sub-tasks go exactly three levels deep and the fourth is refused by name', () => {
  const { doc, ids } = fresh();
  const listId = doc.lists[0].id;
  const l1 = add(doc, { listId, title: 'Level one' }, ids);
  const l2 = add(l1.doc, { parentId: l1.id, title: 'Level two' }, ids);
  const l3 = add(l2.doc, { parentId: l2.id, title: 'Level three' }, ids);

  assert.equal(find(l3.doc, l1.id).depth, 0);
  assert.equal(find(l3.doc, l2.id).depth, 1);
  assert.equal(find(l3.doc, l3.id).depth, 2);
  assert.equal(MAX_DEPTH, 2);

  const refused = applyOp(l3.doc, { type: 'task.add', parentId: l3.id, title: 'Level four' }, { now: AT });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /three levels deep/);
  assert.match(refused.reason, /Level three/, 'the refusal names the task that is already at the bottom');

  // A sub-task inherits its parent's list, whatever listId was asked for.
  const other = applyOp(l3.doc, { type: 'list.add', name: 'Elsewhere' }, { now: AT, idFactory: ids });
  const nested = add(other.doc, { parentId: l1.id, listId: other.listId, title: 'Still level two' }, ids);
  assert.equal(find(nested.doc, nested.id).listId, listId);
});

test('4) completing a parent completes its subtree, and unticking restores exactly that much', () => {
  const { doc, ids } = fresh();
  const listId = doc.lists[0].id;
  const parent = add(doc, { listId, title: 'Ship the release' }, ids);
  const kidA = add(parent.doc, { parentId: parent.id, title: 'Run the gate' }, ids);
  const kidB = add(kidA.doc, { parentId: parent.id, title: 'Write the notes' }, ids);
  const grand = add(kidB.doc, { parentId: kidA.id, title: 'Two runs green' }, ids);

  // One child was finished on its own, BEFORE the parent was ticked.
  const early = applyOp(grand.doc, { type: 'task.setDone', taskId: kidB.id }, { now: AT });
  assert.equal(early.ok, true);
  assert.equal(find(early.doc, kidB.id).completedBy, null, 'finished on its own, not by a parent');

  const ticked = applyOp(early.doc, { type: 'task.setDone', taskId: parent.id }, { now: AT + 1000 });
  assert.equal(ticked.ok, true);
  for (const id of [parent.id, kidA.id, kidB.id, grand.id]) {
    assert.equal(find(ticked.doc, id).done, true, `${id} is done`);
  }
  assert.equal(find(ticked.doc, kidA.id).completedBy, parent.id);
  assert.equal(find(ticked.doc, grand.id).completedBy, parent.id);
  assert.equal(find(ticked.doc, kidB.id).completedBy, null, 'the early finish keeps its own provenance');
  assert.equal(find(ticked.doc, parent.id).completedAt, AT + 1000);

  const unticked = applyOp(ticked.doc, { type: 'task.setDone', taskId: parent.id, done: false }, { now: AT + 2000 });
  assert.equal(unticked.ok, true);
  assert.equal(find(unticked.doc, parent.id).done, false);
  assert.equal(find(unticked.doc, kidA.id).done, false, 'cascaded children come back');
  assert.equal(find(unticked.doc, grand.id).done, false);
  assert.equal(
    find(unticked.doc, kidB.id).done,
    true,
    'the child finished before the cascade STAYS done: unticking must not undo work it did not do',
  );
});

test('5) completing a child never completes its parent', () => {
  const { doc, ids } = fresh();
  const listId = doc.lists[0].id;
  const parent = add(doc, { listId, title: 'Parent' }, ids);
  const only = add(parent.doc, { parentId: parent.id, title: 'Only child' }, ids);
  const done = applyOp(only.doc, { type: 'task.setDone', taskId: only.id }, { now: AT });
  assert.equal(find(done.doc, only.id).done, true);
  assert.equal(find(done.doc, parent.id).done, false);
});

test('6) My Day is a date stamp, so it empties itself the next day without a background job', () => {
  const { doc, ids } = fresh();
  const listId = doc.lists[0].id;
  const today = add(doc, { listId, title: 'Today thing', myDay: true }, ids);
  const task = find(today.doc, today.id);
  assert.equal(task.myDayDate, TODAY);
  assert.equal(isMyDay(task, TODAY), true);
  assert.equal(isMyDay(task, shiftDay(TODAY, 1)), false, 'tomorrow it is no longer in My Day');

  // And counts agree with the selector, which is what the nav badge reads.
  assert.equal(counts(today.doc, TODAY).myday, 1);
  assert.equal(counts(today.doc, shiftDay(TODAY, 1)).myday, 0);

  const off = applyOp(today.doc, { type: 'task.update', taskId: today.id, patch: { myDay: false } }, { now: AT });
  assert.equal(find(off.doc, today.id).myDayDate, null);
});

test('7) the day rolls at 6am, not midnight, so a 1am session is still on the same day', () => {
  assert.equal(dayKey(new Date(2026, 6, 30, 23, 59)), '2026-07-30');
  assert.equal(dayKey(new Date(2026, 6, 31, 0, 30)), '2026-07-30', '00:30 belongs to the day that has not ended');
  assert.equal(dayKey(new Date(2026, 6, 31, 5, 59)), '2026-07-30');
  assert.equal(dayKey(new Date(2026, 6, 31, 6, 0)), '2026-07-31', 'and 6am starts the new one');

  // The wait until the next roll is always positive and inside a day.
  const wait = model.msUntilDayRoll(new Date(2026, 6, 31, 5, 0));
  assert.equal(wait, 60 * 60 * 1000);
  assert.ok(model.msUntilDayRoll(new Date(2026, 6, 31, 6, 30)) > 0);
});

test('8) due states read relative to today, and a finished task is never overdue', () => {
  const { doc, ids } = fresh();
  const listId = doc.lists[0].id;
  const late = add(doc, { listId, title: 'Late', dueDate: shiftDay(TODAY, -3) }, ids);
  const soon = add(late.doc, { listId, title: 'Today', dueDate: TODAY }, ids);
  const next = add(soon.doc, { listId, title: 'Tomorrow', dueDate: shiftDay(TODAY, 1) }, ids);
  const far = add(next.doc, { listId, title: 'Later', dueDate: shiftDay(TODAY, 30) }, ids);
  const none = add(far.doc, { listId, title: 'Someday' }, ids);

  assert.equal(dueState(find(none.doc, late.id), TODAY), 'overdue');
  assert.equal(dueState(find(none.doc, soon.id), TODAY), 'today');
  assert.equal(dueState(find(none.doc, next.id), TODAY), 'tomorrow');
  assert.equal(dueState(find(none.doc, far.id), TODAY), 'future');
  assert.equal(dueState(find(none.doc, none.id), TODAY), null);

  const stats = counts(none.doc, TODAY);
  assert.equal(stats.overdue, 1);
  assert.equal(stats.dueToday, 1);
  assert.equal(stats.planned, 4);

  const finished = applyOp(none.doc, { type: 'task.setDone', taskId: late.id }, { now: AT });
  assert.equal(dueState(find(finished.doc, late.id), TODAY), 'done', 'nagging about finished work is noise');
  assert.equal(counts(finished.doc, TODAY).overdue, 0);
});

test('9) a hand-edited file is repaired rather than trusted: cycles, orphans, depth, junk', () => {
  const repaired = normalizeDoc({
    version: 1,
    lists: [{ id: 'L1', name: 'One' }, { id: 'L1', name: 'Duplicate id' }, { id: 'L2', name: '' }],
    tasks: [
      { id: 'a', listId: 'L1', title: 'Root', parentId: null },
      { id: 'b', listId: 'L1', title: 'Points at a missing parent', parentId: 'ghost' },
      { id: 'c', listId: 'L1', title: 'Points at itself', parentId: 'c' },
      // A two-task cycle.
      { id: 'd', listId: 'L1', title: 'Cycle one', parentId: 'e' },
      { id: 'e', listId: 'L1', title: 'Cycle two', parentId: 'd' },
      // A parent in a different list.
      { id: 'f', listId: 'L2', title: 'Cross-list child', parentId: 'a' },
      // Four levels deep: the deepest is lifted, never deleted.
      { id: 'g', listId: 'L1', title: 'g', parentId: 'a' },
      { id: 'h', listId: 'L1', title: 'h', parentId: 'g' },
      { id: 'i', listId: 'L1', title: 'i', parentId: 'h' },
      { id: 'j', listId: 'L1', title: 'j', parentId: 'i' },
      { id: 'k', listId: 'L1', title: '   ' },
      'not an object',
      null,
    ],
  }, { now: AT, idFactory: seededIds() });

  assert.equal(repaired.lists.length, 2, 'the duplicate list id is dropped');
  assert.equal(repaired.lists[1].name, 'Untitled list', 'a nameless list still gets a name');
  const byId = new Map(repaired.tasks.map((t) => [t.id, t]));
  assert.equal(byId.has('k'), false, 'a task with no title is not a task');
  assert.equal(repaired.tasks.length, 10, 'every titled task survives; only junk is dropped');
  assert.equal(byId.get('b').parentId, null, 'a missing parent drops to a root');
  assert.equal(byId.get('c').parentId, null, 'self-parenting drops to a root');
  assert.ok(byId.get('d').parentId === null || byId.get('e').parentId === null, 'the cycle is broken');
  assert.equal(byId.get('f').parentId, null, 'a cross-list parent drops to a root');
  // Over-deep branches FLATTEN onto the deepest legal ancestor rather than being
  // deleted: i and j were levels 4 and 5, and both come back as level-3 siblings
  // of h under g. Nothing is lost and the shape stays legal.
  assert.equal(byId.get('i').depth, MAX_DEPTH);
  assert.equal(byId.get('i').parentId, 'g');
  assert.equal(byId.get('j').depth, MAX_DEPTH, 'the fifth level is lifted to the deepest legal one');
  assert.equal(byId.get('j').parentId, 'g');
  for (const task of repaired.tasks) {
    assert.ok(task.depth <= MAX_DEPTH, `${task.id} is within the depth limit`);
  }

  // And total: anything at all comes back usable.
  for (const junk of [null, undefined, 42, 'nope', [], { tasks: 'no' }, { lists: 7 }]) {
    const out = normalizeDoc(junk, { now: AT, idFactory: seededIds() });
    assert.equal(out.lists.length >= 1, true);
    assert.deepEqual(out.tasks, []);
  }
});

test('10) a list renders as a tree, and filtering keeps the ancestors that lead to a match', () => {
  const { doc, ids } = fresh();
  const listId = doc.lists[0].id;
  const parent = add(doc, { listId, title: 'Quarterly reporting' }, ids);
  const child = add(parent.doc, { parentId: parent.id, title: 'Pull the numbers' }, ids);
  const grand = add(child.doc, { parentId: child.id, title: 'Reconcile with Epic' }, ids);
  const sibling = add(grand.doc, { listId, title: 'Unrelated errand' }, ids);

  const all = selectRows(sibling.doc, { view: 'list', listId, today: TODAY });
  assert.equal(all.mode, 'tree');
  assert.deepEqual(all.open.map((r) => r.task.title), [
    'Quarterly reporting', 'Pull the numbers', 'Reconcile with Epic', 'Unrelated errand',
  ]);
  assert.deepEqual(all.open.map((r) => r.depth), [0, 1, 2, 0]);
  assert.equal(all.open[0].childCount, 1);

  const filtered = selectRows(sibling.doc, { view: 'list', listId, today: TODAY, query: 'Epic' });
  assert.deepEqual(filtered.open.map((r) => r.task.title), [
    'Quarterly reporting', 'Pull the numbers', 'Reconcile with Epic',
  ]);
  assert.deepEqual(filtered.open.map((r) => r.scaffold), [true, true, false],
    'ancestors are kept only to reach the match, and say so');
});

test('11) a smart view is flat and carries the trail, so a starred level-3 task is reachable', () => {
  const { doc, ids } = fresh();
  const listId = doc.lists[0].id;
  const parent = add(doc, { listId, title: 'Quarterly reporting' }, ids);
  const child = add(parent.doc, { parentId: parent.id, title: 'Pull the numbers' }, ids);
  const grand = add(child.doc, { parentId: child.id, title: 'Reconcile with Epic' }, ids);
  const starred = applyOp(grand.doc, {
    type: 'task.update', taskId: grand.id, patch: { starred: true },
  }, { now: AT });

  const rows = selectRows(starred.doc, { view: 'important', today: TODAY });
  assert.equal(rows.mode, 'flat');
  assert.equal(rows.open.length, 1);
  assert.equal(rows.open[0].task.title, 'Reconcile with Epic');
  assert.equal(rows.open[0].depth, 0, 'a flat view does not indent');
  assert.deepEqual(rows.open[0].breadcrumb, ['Quarterly reporting', 'Pull the numbers']);
  assert.equal(rows.open[0].listName, 'Tasks');
});

test('12) reorder moves a task among its siblings and nowhere else', () => {
  const { doc, ids } = fresh();
  const listId = doc.lists[0].id;
  let current = doc;
  const madeIds = [];
  for (const title of ['A', 'B', 'C', 'D']) {
    const step = add(current, { listId, title }, ids);
    current = step.doc;
    madeIds.push(step.id);
  }
  const titles = (d) => selectRows(d, { view: 'list', listId, today: TODAY }).open.map((r) => r.task.title);
  assert.deepEqual(titles(current), ['A', 'B', 'C', 'D']);

  const moved = applyOp(current, { type: 'task.reorder', taskId: madeIds[3], toIndex: 1 }, { now: AT });
  assert.equal(moved.ok, true);
  assert.deepEqual(titles(moved.doc), ['A', 'D', 'B', 'C']);

  const before = applyOp(moved.doc, { type: 'task.reorder', taskId: madeIds[0], beforeId: madeIds[2] }, { now: AT });
  assert.deepEqual(titles(before.doc), ['D', 'B', 'A', 'C']);

  // Out of range clamps rather than throwing or dropping the task.
  const clamped = applyOp(before.doc, { type: 'task.reorder', taskId: madeIds[1], toIndex: 99 }, { now: AT });
  assert.deepEqual(titles(clamped.doc), ['D', 'A', 'C', 'B']);
});

test('13) deleting takes the whole subtree, and deleting a list takes its tasks', () => {
  const { doc, ids } = fresh();
  const listId = doc.lists[0].id;
  const parent = add(doc, { listId, title: 'Parent' }, ids);
  const child = add(parent.doc, { parentId: parent.id, title: 'Child' }, ids);
  const grand = add(child.doc, { parentId: child.id, title: 'Grandchild' }, ids);
  const keep = add(grand.doc, { listId, title: 'Survivor' }, ids);

  const removed = applyOp(keep.doc, { type: 'task.remove', taskId: parent.id }, { now: AT });
  assert.equal(removed.ok, true);
  assert.equal(removed.removed, 3);
  assert.deepEqual(removed.doc.tasks.map((t) => t.title), ['Survivor']);

  // The last list cannot be deleted, because there would be nowhere to put a task.
  const lastRefused = applyOp(removed.doc, { type: 'list.remove', listId }, { now: AT });
  assert.equal(lastRefused.ok, false);
  assert.match(lastRefused.reason, /only list/);

  const second = applyOp(removed.doc, { type: 'list.add', name: 'example-org' }, { now: AT, idFactory: ids });
  const inSecond = add(second.doc, { listId: second.listId, title: 'Renewals' }, ids);
  const dropped = applyOp(inSecond.doc, { type: 'list.remove', listId: second.listId }, { now: AT });
  assert.equal(dropped.ok, true);
  assert.deepEqual(dropped.doc.tasks.map((t) => t.title), ['Survivor']);
  assert.equal(dropped.doc.lists.length, 1);
});

test('14) moving a task to another list takes its sub-tasks; a sub-task alone cannot move', () => {
  const { doc, ids } = fresh();
  const listId = doc.lists[0].id;
  const second = applyOp(doc, { type: 'list.add', name: 'example-org' }, { now: AT, idFactory: ids });
  const parent = add(second.doc, { listId, title: 'Parent' }, ids);
  const child = add(parent.doc, { parentId: parent.id, title: 'Child' }, ids);

  const moved = applyOp(child.doc, {
    type: 'task.update', taskId: parent.id, patch: { listId: second.listId },
  }, { now: AT });
  assert.equal(moved.ok, true);
  assert.equal(find(moved.doc, parent.id).listId, second.listId);
  assert.equal(find(moved.doc, child.id).listId, second.listId, 'the sub-task follows its parent');

  const refused = applyOp(moved.doc, {
    type: 'task.update', taskId: child.id, patch: { listId },
  }, { now: AT });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /top-level task/);
});

test('15) tags are deduped case-insensitively, keep their typed casing, and index by use', () => {
  const { doc, ids } = fresh();
  const listId = doc.lists[0].id;
  const one = add(doc, { listId, title: 'Renewal review', tags: [' Work ', 'work', 'EB', ''] }, ids);
  assert.deepEqual(find(one.doc, one.id).tags, ['Work', 'EB']);

  const two = add(one.doc, { listId, title: 'Comp study', tags: ['work'] }, ids);
  const index = tagIndex(two.doc);
  assert.deepEqual(index.map((e) => [e.tag, e.open]), [['Work', 2], ['EB', 1]]);

  const done = applyOp(two.doc, { type: 'task.setDone', taskId: two.id }, { now: AT });
  assert.deepEqual(
    tagIndex(done.doc).map((e) => [e.tag, e.open, e.total]),
    [['Work', 1, 2], ['EB', 1, 1]],
    'an equal open count breaks on total use, so a long-running tag stays on top',
  );

  // A tag filter matches whatever casing was typed.
  const rows = selectRows(done.doc, { view: 'all', today: TODAY, tag: 'WORK' });
  assert.deepEqual(rows.open.map((r) => r.task.title), ['Renewal review']);
});

test('16) clearing completed removes only completed work, in scope, and says when there is none', () => {
  const { doc, ids } = fresh();
  const listId = doc.lists[0].id;
  const second = applyOp(doc, { type: 'list.add', name: 'Other' }, { now: AT, idFactory: ids });
  const a = add(second.doc, { listId, title: 'Done here' }, ids);
  const b = add(a.doc, { listId, title: 'Open here' }, ids);
  const c = add(b.doc, { listId: second.listId, title: 'Done there' }, ids);
  let current = applyOp(c.doc, { type: 'task.setDone', taskId: a.id }, { now: AT }).doc;
  current = applyOp(current, { type: 'task.setDone', taskId: c.id }, { now: AT }).doc;

  const scoped = applyOp(current, { type: 'tasks.purgeCompleted', listId }, { now: AT });
  assert.equal(scoped.ok, true);
  assert.equal(scoped.removed, 1);
  assert.deepEqual(scoped.doc.tasks.map((t) => t.title).sort(), ['Done there', 'Open here']);

  const nothing = applyOp(scoped.doc, { type: 'tasks.purgeCompleted', listId }, { now: AT });
  assert.equal(nothing.ok, false);
  assert.match(nothing.reason, /nothing completed/);
});

test('17) applyOp never mutates the document it was given, and refuses an unknown op', () => {
  const { doc, ids } = fresh();
  const listId = doc.lists[0].id;
  const before = JSON.stringify(doc);
  const added = add(doc, { listId, title: 'Something' }, ids);
  assert.equal(JSON.stringify(doc), before, 'the input document is untouched');
  assert.equal(added.doc.tasks.length, 1);

  const unknown = applyOp(added.doc, { type: 'task.explode' }, { now: AT });
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /unknown operation/);
  assert.equal(applyOp(added.doc, null, { now: AT }).ok, false);
  assert.equal(applyOp(added.doc, {}, { now: AT }).ok, false);

  // A missing task is a refusal with a reason, never a throw.
  assert.match(applyOp(added.doc, { type: 'task.setDone', taskId: 'gone' }, { now: AT }).reason, /no longer exists/);
});

test('18) sorting: due date puts undated work last, and titles compare naturally', () => {
  const { doc, ids } = fresh();
  const listId = doc.lists[0].id;
  let current = doc;
  let tick = 0;
  for (const [title, fields] of [
    ['zebra', { dueDate: shiftDay(TODAY, 5) }],
    ['apple', { starred: true }],
    ['Mango', { dueDate: shiftDay(TODAY, -1) }],
    ['berry', {}],
  ]) {
    tick += 1000;
    current = add(current, { listId, title, ...fields }, ids, AT + tick).doc;
  }
  const order = (sort) => selectRows(current, { view: 'list', listId, today: TODAY, sort }).open.map((r) => r.task.title);
  // apple is starred, so My order floats it (spec 18b); the EXPLICIT sorts are
  // left literal, because overriding "sort by due date" with a pin would be the
  // app arguing with a direct instruction.
  assert.deepEqual(order('manual'), ['apple', 'zebra', 'Mango', 'berry']);
  assert.deepEqual(order('due'), ['Mango', 'zebra', 'apple', 'berry']);
  assert.deepEqual(order('title'), ['apple', 'berry', 'Mango', 'zebra'], 'case-insensitive');
  assert.deepEqual(order('created'), ['berry', 'Mango', 'apple', 'zebra']);
  // 'importance' is gone rather than left in the menu meaning what My order
  // already does; an unknown sort falls back to manual rather than throwing.
  assert.equal(model.SORTS.includes('importance'), false);
  assert.deepEqual(order('importance'), order('manual'));
});

test('18b) a star pins its task to the top of the order it sits in, and nowhere else', () => {
  const { doc, ids } = fresh();
  const listId = doc.lists[0].id;
  const second = applyOp(doc, { type: 'list.add', name: 'Work' }, { now: AT, idFactory: ids });
  const workId = second.doc.lists[1].id;
  let current = second.doc;
  const made = {};
  for (const [key, fields] of [
    ['a', { listId, title: 'A' }],
    ['b', { listId, title: 'B' }],
    ['c', { listId, title: 'C' }],
    ['kid1', { parentId: null, title: 'Kid one' }],
    ['kid2', { parentId: null, title: 'Kid two' }],
    ['work', { listId: workId, title: 'Work thing' }],
  ]) {
    const parentId = key.startsWith('kid') ? made.a : fields.parentId;
    const step = add(current, { ...fields, parentId: parentId || undefined }, ids);
    current = step.doc;
    made[key] = step.id;
  }
  const star = (id, on = true) => {
    const out = applyOp(current, { type: 'task.update', taskId: id, patch: { starred: on } }, { now: AT });
    assert.equal(out.ok, true, out.reason);
    current = out.doc;
  };
  const listTitles = () => selectRows(current, { view: 'list', listId, today: TODAY })
    .open.map((r) => r.task.title);

  assert.deepEqual(listTitles(), ['A', 'Kid one', 'Kid two', 'B', 'C']);

  // A root star goes to the top of its list.
  star(made.c);
  assert.deepEqual(listTitles(), ['C', 'A', 'Kid one', 'Kid two', 'B']);

  // A sub-task star rises among its OWN siblings and never leaves its parent.
  star(made.kid2);
  assert.deepEqual(listTitles(), ['C', 'A', 'Kid two', 'Kid one', 'B']);

  // Unstarring puts it back where its order always said it was.
  star(made.c, false);
  assert.deepEqual(listTitles(), ['A', 'Kid two', 'Kid one', 'B', 'C']);

  // A flat smart view pins across lists too: a star at the head of the third
  // list would be the same thing as no star at all.
  star(made.work);
  // Every star first (grouped by list among themselves, since My order across
  // lists is otherwise meaningless), then the rest in their own list order.
  const flat = selectRows(current, { view: 'all', today: TODAY }).open.map((r) => r.task.title);
  assert.deepEqual(flat, ['Kid two', 'Work thing', 'A', 'Kid one', 'B', 'C']);

  // And a completed star sits at the top of the Completed section, not mixed in
  // with the open work.
  const finished = applyOp(current, { type: 'task.setDone', taskId: made.b }, { now: AT });
  const withDone = applyOp(finished.doc, { type: 'task.setDone', taskId: made.c }, { now: AT });
  const starredDone = applyOp(withDone.doc, {
    type: 'task.update', taskId: made.c, patch: { starred: true },
  }, { now: AT });
  const rows = selectRows(starredDone.doc, { view: 'list', listId, today: TODAY });
  assert.deepEqual(rows.done.map((r) => r.task.title), ['C', 'B']);
  assert.equal(rows.open.some((r) => r.task.title === 'B'), false, 'no task appears twice');
});

test('19) a completed root takes its subtree into the Completed section, never both places', () => {
  const { doc, ids } = fresh();
  const listId = doc.lists[0].id;
  const parent = add(doc, { listId, title: 'Parent' }, ids);
  const child = add(parent.doc, { parentId: parent.id, title: 'Child' }, ids);
  const other = add(child.doc, { listId, title: 'Still going' }, ids);
  const done = applyOp(other.doc, { type: 'task.setDone', taskId: parent.id }, { now: AT });

  const rows = selectRows(done.doc, { view: 'list', listId, today: TODAY });
  assert.deepEqual(rows.open.map((r) => r.task.title), ['Still going']);
  assert.deepEqual(rows.done.map((r) => r.task.title), ['Parent', 'Child']);
  const seen = new Set([...rows.open, ...rows.done].map((r) => r.task.id));
  assert.equal(seen.size, 3, 'no task appears twice');
});

test('20) task.duplicate copies facts, resets open state, remaps the subtree, and sits right after', () => {
  const { doc, ids } = fresh();
  const listId = doc.lists[0].id;
  const a = add(doc, { listId, title: 'Alpha' }, ids);
  const b = add(a.doc, {
    listId,
    title: 'Ship the release',
    notes: 'keep the notes',
    starred: true,
    myDayDate: TODAY,
    dueDate: shiftDay(TODAY, 2),
    tags: ['release', 'ops'],
  }, ids);
  const c = add(b.doc, { listId, title: 'Charlie' }, ids);
  const kid = add(c.doc, { parentId: b.id, title: 'Run the gate', tags: ['gate'], notes: 'kid note' }, ids);
  const grand = add(kid.doc, { parentId: kid.id, title: 'Two runs green', dueDate: TODAY }, ids);

  // Finish the whole branch so the copy must reopen every node.
  const closed = applyOp(grand.doc, { type: 'task.setDone', taskId: b.id }, { now: AT + 500 });
  assert.equal(closed.ok, true);
  assert.equal(find(closed.doc, b.id).done, true);
  assert.equal(find(closed.doc, kid.id).done, true);
  assert.equal(find(closed.doc, grand.id).done, true);

  const DUP_AT = AT + 2000;
  const result = applyOp(closed.doc, { type: 'task.duplicate', taskId: b.id }, {
    now: DUP_AT, idFactory: ids, today: TODAY,
  });
  assert.equal(result.ok, true, result.reason);
  assert.ok(result.taskId, 'returns the copy root id');
  assert.notEqual(result.taskId, b.id);

  const copy = find(result.doc, result.taskId);
  const src = find(result.doc, b.id);
  assert.equal(copy.title, src.title);
  assert.equal(copy.notes, 'keep the notes');
  assert.equal(copy.dueDate, shiftDay(TODAY, 2));
  assert.equal(copy.starred, true);
  assert.deepEqual(copy.tags, ['release', 'ops']);
  assert.equal(copy.myDayDate, TODAY);
  assert.equal(copy.listId, listId);
  assert.equal(copy.parentId, null);
  assert.equal(copy.done, false);
  assert.equal(copy.completedAt, null);
  assert.equal(copy.completedBy, null);
  assert.equal(copy.createdAt, DUP_AT);
  assert.equal(copy.updatedAt, DUP_AT);

  // Original stays finished; its identity is untouched.
  assert.equal(src.done, true);
  assert.equal(src.id, b.id);

  const copyKids = model.childrenOf(result.doc, copy.id);
  assert.equal(copyKids.length, 1);
  assert.equal(copyKids[0].title, 'Run the gate');
  assert.notEqual(copyKids[0].id, kid.id);
  assert.equal(copyKids[0].parentId, copy.id);
  assert.equal(copyKids[0].done, false);
  assert.equal(copyKids[0].completedAt, null);
  assert.equal(copyKids[0].completedBy, null);
  assert.deepEqual(copyKids[0].tags, ['gate']);
  assert.equal(copyKids[0].notes, 'kid note');
  assert.equal(copyKids[0].createdAt, DUP_AT);

  const copyGrand = model.childrenOf(result.doc, copyKids[0].id);
  assert.equal(copyGrand.length, 1);
  assert.equal(copyGrand[0].title, 'Two runs green');
  assert.notEqual(copyGrand[0].id, grand.id);
  assert.equal(copyGrand[0].parentId, copyKids[0].id);
  assert.equal(copyGrand[0].done, false);
  assert.equal(copyGrand[0].completedAt, null);
  assert.equal(copyGrand[0].completedBy, null);
  assert.equal(copyGrand[0].dueDate, TODAY);

  // All copied ids are fresh (none collide with the source subtree).
  const sourceIds = new Set([b.id, kid.id, grand.id]);
  const copyIds = [copy.id, copyKids[0].id, copyGrand[0].id];
  for (const id of copyIds) assert.equal(sourceIds.has(id), false);

  // Copy sits immediately after the original among siblings: A, B, copy, C.
  const roots = model.rootsOf(result.doc, listId).map((t) => t.id);
  assert.deepEqual(roots, [a.id, b.id, copy.id, c.id]);

  // Depth is preserved, never deepened past the cap.
  assert.equal(copy.depth, 0);
  assert.equal(copyKids[0].depth, 1);
  assert.equal(copyGrand[0].depth, 2);
  assert.equal(result.doc.tasks.filter((t) => t.depth > MAX_DEPTH).length, 0);
});

test('20b) task.duplicate refuses an unknown id the way other ops do', () => {
  const { doc } = fresh();
  const refused = applyOp(doc, { type: 'task.duplicate', taskId: 'missing' }, { now: AT });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /no longer exists/);
});

test('20c) duplicating a completed parent yields an open copy (and leaves the original done)', () => {
  const { doc, ids } = fresh();
  const listId = doc.lists[0].id;
  const parent = add(doc, { listId, title: 'Done parent' }, ids);
  const child = add(parent.doc, { parentId: parent.id, title: 'Done child' }, ids);
  const closed = applyOp(child.doc, { type: 'task.setDone', taskId: parent.id }, { now: AT });
  const result = applyOp(closed.doc, { type: 'task.duplicate', taskId: parent.id }, {
    now: AT + 1, idFactory: ids,
  });
  assert.equal(result.ok, true, result.reason);
  assert.equal(find(result.doc, parent.id).done, true);
  assert.equal(find(result.doc, result.taskId).done, false);
  const copyChild = model.childrenOf(result.doc, result.taskId)[0];
  assert.equal(copyChild.done, false);
  assert.equal(copyChild.completedBy, null);
});

test('duplicate strips assignment breadcrumbs but keeps real notes', () => {
  const AT = '2026-08-25T12:00:00.000Z';
  const seeded = applyOp(emptyDoc(AT), { type: 'task.add', title: 'original' }, { now: AT }).doc;
  const id = seeded.tasks.find((t) => t.title === 'original').id;
  const noted = applyOp(seeded, { type: 'task.update', taskId: id, patch: { notes: 'real context line' } }, { now: AT }).doc;
  const assigned = applyOp(noted, { type: 'task.appendAssignment', taskId: id, sessionId: 'abc-123' }, { now: AT }).doc;
  const result = applyOp(assigned, { type: 'task.duplicate', taskId: id }, { now: AT });
  const copy = result.doc.tasks.find((t) => t.id === result.taskId);
  assert.match(assigned.tasks.find((t) => t.id === id).notes, /Assigned to Claude session abc-123/);
  assert.equal(copy.notes, 'real context line', 'the copy keeps real notes and drops the assignment line');

  // A copy whose notes were ONLY breadcrumbs must come back as a STRING: a
  // null here crashed the search selector, and the model's invariant is that
  // notes is always a string.
  const bare = applyOp(seeded, { type: 'task.appendAssignment', taskId: id, sessionId: 'xyz-789' }, { now: AT }).doc;
  const bareCopy = applyOp(bare, { type: 'task.duplicate', taskId: id }, { now: AT });
  const copied = bareCopy.doc.tasks.find((t) => t.id === bareCopy.taskId);
  assert.equal(copied.notes, '', 'breadcrumb-only notes duplicate to an empty string, never null');
  assert.doesNotThrow(() => model.selectRows(bareCopy.doc, { view: 'all', query: 'x', today: '2026-08-25' }));

  // A hand-typed line that merely starts the same way is a real note and
  // survives the strip.
  const typed = applyOp(seeded, { type: 'task.update', taskId: id, patch: { notes: 'Assigned to Claude session handling is flaky, check later' } }, { now: AT }).doc;
  const typedCopy = applyOp(typed, { type: 'task.duplicate', taskId: id }, { now: AT });
  assert.match(typedCopy.doc.tasks.find((t) => t.id === typedCopy.taskId).notes, /handling is flaky/);

  // A breadcrumb the 20k notes cap truncated mid-stamp is still one trailing
  // token after ' at ', so it strips too (round-2 review catch).
  const truncated = applyOp(seeded, { type: 'task.update', taskId: id, patch: { notes: 'keep me' + String.fromCharCode(10) + 'Assigned to Claude session abc-123 at 2026-08-2' } }, { now: AT }).doc;
  const truncCopy = applyOp(truncated, { type: 'task.duplicate', taskId: id }, { now: AT });
  assert.equal(truncCopy.doc.tasks.find((t) => t.id === truncCopy.taskId).notes, 'keep me');
});
