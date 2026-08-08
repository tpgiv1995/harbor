import React from 'react';

export function LiveVoiceBar({ liveVoice }) {
  if (!liveVoice || liveVoice.phase === 'idle') return null;
  const recent = liveVoice.activity.slice(-2);
  return (
    <div className={`live-voice-bar ${liveVoice.phase}${liveVoice.speaking ? ' speaking' : ''}`} role="status">
      <span className="live-voice-dot" aria-hidden="true" />
      <span className="live-voice-label">
        {liveVoice.phase === 'connecting' ? 'Connecting live voice…'
          : liveVoice.phase === 'error' ? (liveVoice.message || 'Live voice error')
            : `Live voice (${liveVoice.voice})`}
      </span>
      {recent.map((item) => (
        <span key={item.at} className={`live-voice-act ${item.kind}`}>
          <b>{item.kind}</b> {item.text}
        </span>
      ))}
    </div>
  );
}
