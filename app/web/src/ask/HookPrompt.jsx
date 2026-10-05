import React from 'react';
import { AskForm } from '../../../src/renderer/stage/AskForm.jsx';
import { PromptForm } from '../../../src/renderer/stage/PromptForm.jsx';
import './hook-prompt.css';
export function HookPrompt({ client, ask }) {
  const answer = (id, payload) => client.call('ask:answer', { id, ...payload });
  return (
    <div className="phone-hook-prompt">
      {ask.kind && ask.kind !== 'ask' ? (
        <PromptForm key={ask.id} ask={ask} onAnswer={answer} device="phone" />
      ) : (
        <AskForm
          key={ask.id}
          ask={ask}
          attachments={false}
          selected
          onAnswer={answer}
          onDecline={(id, reason) => client.call('ask:decline', { id, reason })}
          onChat={() => window.dispatchEvent(new Event('harbor-focus-composer'))}
        />
      )}
    </div>
  );
}
