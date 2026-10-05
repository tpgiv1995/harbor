import React from 'react';
import './plan-choices.css';

export function PlanChoices({ plans, value, onChange, disabled = false }) {
  return <div className="plan-choices" role="group" aria-label="Plan">
    {plans.map(plan => <button type="button" key={plan.id} aria-pressed={value === plan.id}
      disabled={disabled} onClick={() => onChange(plan.id)} style={{ '--plan-color': plan.color || 'var(--ac)' }}>
      <span className="plan-letter" aria-hidden="true">{plan.letter || plan.label?.slice(0, 1) || plan.id.slice(0, 1)}</span>
      <span>{plan.label || plan.id}</span>
    </button>)}
  </div>;
}
