'use strict';

// The tools Harbor's voice agent is allowed to call, and the dispatcher that
// runs one. PURE: every effect arrives as an injected function, so the whole
// contract is testable without a microphone, a WebRTC connection, or a live
// model.
//
// The ask was a live voice mode useful inside Harbor rather than a second
// ChatGPT (2026-07-27). That means the thing the user talks to has to be able to
// SEE their open sessions and TYPE INTO them, so these five tools are the entire
// surface it gets. Deliberately not on the list: closing windows, killing
// processes, launching sessions, answering permission dialogs. A misheard word
// should never be able to destroy work, and every one of those has a
// keyboard-only path already.
//
// A voice-initiated send goes through the SAME send path as a typed one, so
// every existing guard still applies (dead shell, blocked pane, resume then
// send) and the message shows up in the conversation as an ordinary prompt
// bubble. There is no such thing as an invisible voice send.

const TOOL_DEFS = Object.freeze([
  {
    type: 'function',
    name: 'harbor_list_sessions',
    description: 'List the session windows currently open in Harbor, with their project, '
      + 'title, whether they are working or idle, their model and how much context they have used. '
      + 'Call this before acting on a session so you are using its real id.',
    parameters: {
      type: 'object', properties: {}, required: [], additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'harbor_read_session',
    description: 'Read the most recent messages of one open session, to answer questions '
      + 'about what it is doing or what it last said.',
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'The session id, or its title or project name.' },
        limit: { type: 'integer', description: 'How many recent messages to read. Default 6, max 20.' },
      },
      required: ['session'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'harbor_send_to_session',
    description: 'Type a message into an open Claude session and send it, exactly as if the '
      + 'user had typed it. Use their own words; do not embellish the instruction.',
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'The session id, or its title or project name.' },
        text: { type: 'string', description: 'The message to send.' },
      },
      required: ['session', 'text'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'harbor_interrupt_session',
    description: 'Stop the turn a session is currently running, the same as pressing Escape in '
      + 'the terminal. Use when the user says to stop, halt or cancel what a session is doing.',
    parameters: {
      type: 'object',
      properties: { session: { type: 'string', description: 'The session id, or its title or project name.' } },
      required: ['session'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'harbor_select_session',
    description: 'Make one open session the selected window, so the command bar and the user\'s '
      + 'keyboard are pointed at it.',
    parameters: {
      type: 'object',
      properties: { session: { type: 'string', description: 'The session id, or its title or project name.' } },
      required: ['session'],
      additionalProperties: false,
    },
  },
]);

const TOOL_NAMES = Object.freeze(TOOL_DEFS.map((tool) => tool.name));

const norm = (text) => String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();

// Resolve what the model said into one open session. It gets real ids from
// harbor_list_sessions, but spoken language does not survive a round trip
// through a transcript intact ("tell the harbor one to push"), so a title or
// project name resolves too. AMBIGUITY IS AN ERROR, never a coin flip: picking
// the wrong session here would type the user's instruction into the wrong agent.
function resolveSessionRef(ref, sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  const wanted = norm(ref);
  if (!wanted) return { error: 'no session was named' };

  const exactId = list.find((session) => String(session.id) === String(ref).trim());
  if (exactId) return { session: exactId };

  const score = (session) => {
    const title = norm(session.title);
    const project = norm(session.project);
    if (title === wanted || project === wanted) return 3;
    if (title.startsWith(wanted) || project.startsWith(wanted)) return 2;
    if (title.includes(wanted) || project.includes(wanted)) return 1;
    return 0;
  };
  const scored = list.map((session) => ({ session, points: score(session) })).filter((s) => s.points > 0);
  if (scored.length === 0) {
    return {
      error: `no open session matches "${ref}"`,
      open: list.map((session) => ({ id: session.id, project: session.project, title: session.title })),
    };
  }
  const best = Math.max(...scored.map((s) => s.points));
  const winners = scored.filter((s) => s.points === best);
  if (winners.length > 1) {
    return {
      error: `"${ref}" matches ${winners.length} open sessions; ask which one`,
      candidates: winners.map((s) => ({ id: s.session.id, project: s.session.project, title: s.session.title })),
    };
  }
  return { session: winners[0].session };
}

function clampLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 6;
  return Math.min(20, Math.round(n));
}

// Run one tool call. Returns a plain object to hand straight back to the model
// as the function_call_output; an error is returned as data, never thrown, so a
// bad call becomes something the agent can say out loud and recover from
// instead of a dead conversation.
async function dispatchVoiceTool(name, args, deps = {}) {
  const input = args && typeof args === 'object' ? args : {};
  if (!TOOL_NAMES.includes(name)) return { error: `unknown tool ${name}` };

  const sessions = (await deps.listSessions?.()) || [];

  if (name === 'harbor_list_sessions') {
    if (sessions.length === 0) return { sessions: [], note: 'no session windows are open' };
    return { sessions };
  }

  const resolved = resolveSessionRef(input.session, sessions);
  if (resolved.error) return resolved;
  const target = resolved.session;

  if (name === 'harbor_read_session') {
    const messages = (await deps.readSession?.(target.id, clampLimit(input.limit))) || [];
    return {
      session: { id: target.id, project: target.project, title: target.title, state: target.state },
      messages,
    };
  }

  if (name === 'harbor_send_to_session') {
    const text = String(input.text || '').trim();
    if (!text) return { error: 'nothing to send' };
    const result = await deps.sendToSession?.(target.id, text);
    if (!result?.ok) {
      return {
        sent: false,
        // The send path's own refusal, verbatim. It knows things the agent does
        // not, like that the session is parked on a question it must answer
        // first, and repeating its words keeps the spoken reason true.
        reason: result?.reason || 'the send did not go through',
        session: { id: target.id, title: target.title },
      };
    }
    return { sent: true, session: { id: target.id, project: target.project, title: target.title }, text };
  }

  if (name === 'harbor_interrupt_session') {
    const result = await deps.interruptSession?.(target.id);
    return result?.ok
      ? { interrupted: true, session: { id: target.id, title: target.title } }
      : { interrupted: false, reason: result?.reason || 'could not interrupt that session' };
  }

  // harbor_select_session
  await deps.selectSession?.(target.id);
  return { selected: true, session: { id: target.id, project: target.project, title: target.title } };
}

// What the agent is told it is. Kept here so the spoken persona and the tool
// list cannot drift apart.
const VOICE_INSTRUCTIONS = [
  'You are Harbor\'s voice. Harbor is a desktop app for running several Claude Code',
  'sessions at once, and you are how the user talks to it while their hands are busy.',
  '',
  'Be brief. He is usually mid-task and wants an answer, not a paragraph. One or two',
  'sentences unless they ask for detail. Never read out file paths, ids or code unless',
  'asks; say "the harbor session" rather than a uuid.',
  '',
  'You can see their open sessions and type into them. Before acting on a session, call',
  'harbor_list_sessions so you are working from its real id. When they tell you to pass an',
  'instruction to a session, send THEIR words, not a polished version of them: they are',
  'to a coding agent that will act on the wording.',
  '',
  'When a send is refused, say the refusal reason as given; do not retry silently and do',
  'not invent a reason. If what they said could mean two different sessions, ask which one',
  'rather than guessing, because typing into the wrong agent costs them real work.',
  '',
  'When a session finishes something, relay the outcome in one sentence.',
].join('\n');

module.exports = {
  TOOL_DEFS,
  TOOL_NAMES,
  VOICE_INSTRUCTIONS,
  dispatchVoiceTool,
  resolveSessionRef,
  clampLimit,
};
