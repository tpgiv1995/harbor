import React from 'react';
import './plan-choices.css';

// A plan with a textColor (a dark plan colour, e.g. the black X plan) shows a
// filled letter in that text colour, the desktop's rule (renderer/profiles.cjs
// profileStyle); every other plan keeps the tinted letter.
function planStyle(plan) {
  const style = { '--plan-color': plan.color || 'var(--ac)' };
  if (plan.color && /^#[0-9a-f]{6}$/i.test(String(plan.textColor || ''))) {
    style['--plan-fill'] = plan.color;
    style['--plan-fg'] = plan.textColor;
    style['--plan-edge'] = `color-mix(in srgb, ${plan.textColor} 30%, transparent)`;
  }
  return style;
}

export function PlanChoices({ plans, value, onChange, disabled = false }) {
  return <div className="plan-choices" role="group" aria-label="Plan">
    {plans.map(plan => <button type="button" key={plan.id} aria-pressed={value === plan.id}
      disabled={disabled} onClick={() => onChange(plan.id)} style={planStyle(plan)}>
      <span className="plan-letter" aria-hidden="true">{plan.letter || plan.label?.slice(0, 1) || plan.id.slice(0, 1)}</span>
      <span>{plan.label || plan.id}</span>
    </button>)}
  </div>;
}
