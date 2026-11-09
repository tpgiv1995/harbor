# Codex release notes, 0.166.0 to 0.167.0

Numbered verbatim from Harbor's cli-updates.json registry, checked 2026-11-09T16:23:17.047Z.

## 0.167.0

X1. Open the agent command center with `codex agents --no-daemon`. The command center and session picker now mark unread results (#58238, #58239, #58263, #58264).
X2. Switch between connected backends from the terminal session picker and keep your drafts when switching (#58280, #58457).
X3. Preview local image attachments while composing on supported terminals, and open viewed local images from clickable transcript paths (#58261, #58446).
X4. Find API key and cloud provider options under “Sign in another way.” Enable `gcp_setup_wizard` to set up Google Cloud Vertex AI with Application Default Credentials or a credential file (#57857, #58427).
X5. Opt into macOS or Windows system proxy settings from `/experimental` (#58157).
X6. Expand patch details directly in the transcript while an approval prompt is open (#58281).
X7. Saved chats stay visible after you switch model providers. If a chat can’t resume, you can read its transcript and prepare an editable prompt to continue in a new chat (#58202).
X8. `Ctrl+L` clears the terminal display while keeping earlier messages available through `Ctrl+T` (#58266).
X9. Deleting text that exposes a leading `!` keeps an ordinary draft in chat mode (#58412).
X10. Network approval prompts close when their requests end. Concurrent requests to the same endpoint prompt one at a time (#58350, #58351).
X11. Long realtime V3 conversations save completed speech to chat history as the transcript grows (#58221).
X12. Automatic context compaction now accounts for retained output from failed responses and responses with missing token usage data (#58404).
X13. The app-server README covers managed network constraints under `[permissions.network]` and `prompt-user` command rules that require fresh human approval (#58045, #58182).
X14. The `openai-docs` skill recommends the documented replacement when migrating away from a deprecated model (#58134).
X15. DotSlash manifests now reference the Cargo packages shipped with the release (#58717, #58757).
X16. Linux musl builds use fewer allocator arenas to reduce idle memory after conversations unload (#58399).
