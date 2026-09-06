import React from 'react';

export function AttachChips({ attachments, onRemove }) {
  if (!attachments.length) return null;
  return (
    <div className="attach-chips" aria-label="Attached images">
      {attachments.map((attachment) => (
        <div className="attach-chip" key={attachment.id}>
          <img src={attachment.thumbUrl} alt="" />
          <span>{attachment.name}</span>
          <button
            type="button"
            onClick={() => onRemove(attachment.id)}
            aria-label={`Remove ${attachment.name}`}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      ))}
    </div>
  );
}

