# Harbor reading style

Approved direction: Codex-inspired reading and surrounding UI, with white text.
Use native system typography, near-white #f5f5f5 text, neutral charcoal surfaces,
15px conversation prose at 1.7 line height, a centered 760px reading column,
clear paragraphs and lists, and 13px code. Sidebar labels should be brighter;
metadata remains secondary. Preserve semantic status colors and all existing
session, multi-window, composer, and provider behavior. Resting windows must
retain the same text brightness as the selected window.

Keep changes in a desktop presentation stylesheet imported after styles.css.
Use the existing components for a synthetic preview with no account access.
Verify long code and tables scroll within the column, narrow tiles wrap, and
copy controls remain visible. Build and run the repository gate with a bounded
timeout; report platform failures accurately. User approved preview and local
installation with a rollback copy. Install only after visual verification.
