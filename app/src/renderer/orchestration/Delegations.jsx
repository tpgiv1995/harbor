import React, { useEffect, useRef } from 'react';
import { providerIdentity } from '../providers.js';

function age(ms, now) { return ms ? now - ms < 60000 ? '<1m' : `${Math.floor((now - ms) / 60000)}m` : null; }
function stateLabel(state, lastSignalMs, now) {
  return state === 'quiet' ? `quiet ${age(lastSignalMs, now) || '?'}, possibly hung` : state;
}
function childrenCount(children, kind) {
  return children.reduce((sum, child) => sum + Number(child.kind === kind) + childrenCount(child.children || [], kind), 0);
}
function AgentChildren({ children, onOpenSession, now }) {
  return children.filter((child) => child.kind !== 'guardian').map((child) => (
    <div className="delegation-child" key={child.id}>
      <button type="button" onClick={() => onOpenSession(child.id)}>{child.title}</button>
      <span className={`delegation-state state-${child.state.replace(/ /g, '-')}`}>{stateLabel(child.state, child.lastSignalMs, now)}</span>
      {child.children?.length ? <AgentChildren children={child.children} onOpenSession={onOpenSession} now={now} /> : null}
    </div>
  ));
}
export function Delegations({ groups, focusParentId, onOpenSession }) {
  const root = useRef(null);
  const now = Date.now();
  useEffect(() => {
    if (!focusParentId) return;
    const element = [...(root.current?.querySelectorAll('[data-parent-id]') || [])].find((el) => el.dataset.parentId === focusParentId);
    element?.scrollIntoView({ block: 'nearest' });
  }, [focusParentId, groups]);
  const visible = groups.filter((group) => group.visible || group.parentId === focusParentId);
  if (!visible.length) return null;
  return <section className="delegations" ref={root} aria-label="Delegated agents">
    <h3>Delegated agents</h3>
    {visible.map((group) => <article className={`delegation-group${group.parentId === focusParentId ? ' focused-group' : ''}`} key={group.parentId} data-parent-id={group.parentId}>
      <header className="delegation-group-head">
        <div><span className="delegation-project">{group.project}</span><button type="button" onClick={() => onOpenSession(group.parentId)}>{group.title}</button></div>
        <span className={`delegation-state state-${group.state}`}>{group.state}</span>
      </header>
      {group.agents.map((agent) => {
        const identity = providerIdentity(agent.provider);
        const reviews = childrenCount(agent.children || [], 'guardian');
        return <div className="delegation-agent" key={agent.id} data-agent-id={agent.id}>
          <div className="delegation-agent-head">
            <img src={identity.logo} alt={identity.label} />
            <div className="delegation-agent-copy">
              {agent.sessionId ? <button type="button" onClick={() => onOpenSession(agent.sessionId)}>{agent.description}</button> : <strong>{agent.description}</strong>}
              {agent.prompt ? <p>{agent.prompt}</p> : null}
              <span className="delegation-meta">{agent.model || identity.label} · {agent.lastSignalMs ? `last signal ${age(agent.lastSignalMs, now)} ago` : 'no signal'}{!agent.linked ? ' · conversation not linked' : ''}</span>
            </div>
            <span className={`delegation-state state-${agent.state.replace(/ /g, '-')}`}>{stateLabel(agent.state, agent.lastSignalMs, now)}</span>
          </div>
          <details className="delegation-rounds"><summary>{agent.rounds.length} round{agent.rounds.length === 1 ? '' : 's'}</summary>
            <ol>{agent.rounds.map((round) => <li key={round.id}><span>{round.description}</span><span>{new Date(round.startedMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {['ended', 'ended with session'].includes(round.outcome) ? 'end time unknown' : `${Math.max(0, Math.round(((round.endedMs || now) - round.startedMs) / 60000))}m`} · {round.outcome}</span></li>)}</ol>
          </details>
          <AgentChildren children={agent.children || []} onOpenSession={onOpenSession} now={now} />
          {reviews ? <div className="delegation-reviewers">{reviews} approval review{reviews === 1 ? '' : 's'}</div> : null}
        </div>;
      })}
      {group.tasks.length ? <details className="delegation-tasks"><summary>{group.tasks.length} other background item{group.tasks.length === 1 ? '' : 's'}</summary><ul>{group.tasks.map((task) => <li key={task.id}><span>{task.description}</span><span>{task.kind} · {task.kind === 'cron' && task.status === 'running' ? 'registered' : task.status}</span></li>)}</ul></details> : null}
    </article>)}
  </section>;
}
