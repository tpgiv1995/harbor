import React from 'react';
import './error-boundary.css';

// A failed view may unmount its own content, never the navigation beside it.
// Store the message only, not an error object that can retain a render context.
export class ErrorBoundary extends React.Component {
  state = { message: null };

  static getDerivedStateFromError(error) {
    let message = 'An unexpected rendering error occurred.';
    try { message = String(error?.message || error || message).slice(0, 2000); } catch { /* keep the fallback */ }
    return { message };
  }

  retry = () => this.setState({ message: null });

  render() {
    if (this.state.message === null) return this.props.children;
    const name = this.props.name || 'This view';
    return (
      <section className={`view-error ${this.props.className || ''}`} style={this.props.style} role="alert" aria-label={`${name} error`}>
        <svg className="view-error-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
          <path d="M12 7v6m0 3v1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <h2>{name} could not be displayed</h2>
        <p className="view-error-message">{this.state.message}</p>
        <button type="button" className="view-error-retry" onClick={this.retry}>Retry</button>
      </section>
    );
  }
}
