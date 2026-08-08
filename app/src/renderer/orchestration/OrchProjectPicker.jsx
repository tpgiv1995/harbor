import React from 'react';
import { projectRootSessionId, isScratchProject } from '../../shared/sidebar-model.js';
import { ProjectIcon } from '../stage/ProjectIcon.jsx';

// Orchestration as a top-level view needs a project first: OrchPanel is
// per-project (queue, mutex, kickoff all resolve from a project root). This
// picker lists every project that can answer a root, most recent first; the
// rail's per-project Orch chip skips it by opening the panel directly.
// A project row carries no cwd of its own; its sessions do. Any one of them
// answers "where is this project", and isScratchProject wants both halves
// (a /tmp cwd OR a lane-shaped label) to catch both the claude and cursor
// forms of the same worktree.
function projectCwd(project) {
  for (const session of project.sessions || []) {
    if (typeof session.cwd === 'string' && session.cwd.trim()) return session.cwd;
  }
  return null;
}

export function OrchProjectPicker({ projects, onPick }) {
  // The SAME scratch rule the rail applies. Without it this list was mostly
  // the throwaway worktrees claude-delegate creates per orchestration run
  // (claude-delegate-lanes-<id>/lane-batch-N, and cursor's tmp- munge of the
  // same), one row each, interleaved with the real projects: measured at 25 of
  // 33 rows on Pat's machine, so the surface for choosing a project to
  // orchestrate was four fifths litter from previous orchestrations. The rail
  // has hidden these for months; the picker never learned.
  const rows = (projects || []).filter((project) => (
    !project.isWindowsEra
    && projectRootSessionId(project)
    && !isScratchProject({ label: project.label, cwd: projectCwd(project) })
  ));
  return (
    <div className="orch-picker" aria-label="Pick a project for orchestration">
      <div className="orch-picker-head">
        <h2 className="orch-picker-title">Orchestration</h2>
        <span className="orch-picker-subtitle">Pick a project to see its queue, workers, and kickoff controls</span>
      </div>
      {rows.length === 0 ? (
        <div className="orch-picker-empty">No projects with sessions yet.</div>
      ) : (
        <div className="orch-picker-list">
          {rows.map((project) => (
            <button
              key={project.label}
              type="button"
              className="orch-picker-row"
              onClick={() => onPick({ label: project.label, sessions: project.sessions, queueId: null })}
            >
              <ProjectIcon label={project.label} iconClass="pj-icon" dotClass="pjdot" />
              <span className="orch-picker-label">{project.label}</span>
              <span className="orch-picker-count">
                {project.sessionCount}
                {' '}
                {project.sessionCount === 1 ? 'session' : 'sessions'}
              </span>
              {project.hasLive ? <span className="orch-picker-live" title="Has live sessions" /> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
