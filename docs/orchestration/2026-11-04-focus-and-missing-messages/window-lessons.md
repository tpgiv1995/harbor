# Window audit lessons

Audited in C:\dev\.orch\harbor\astra-audit-1104\app\src\main\index.js and C:\dev\.orch\harbor\astra-audit-1104\app\src\renderer\stage\ComposeEditor.jsx. Corrections use C:\dev\.orch\harbor\astra-audit-1104\app\src\main\window-presentation.js; synthetic window-model regressions are in C:\dev\.orch\harbor\astra-audit-1104\app\test\main\window-presentation-audit.test.js.

- Offscreen position does not prevent Windows activation. The main-window change left the Board harness window born with show:true. Both factories now start hidden, and the Board harness shows inactive.
- Filling the work area with setBounds is not native maximization. It replaces the native normal rectangle and leaves isMaximized false. Persisting that intermediate state loses both the restore rectangle and the saved maximize intent.
- Deferred maximization now retains the original normal rectangle and intended state. Persistence, titlebar state, toggle and resize guards use that state. First activation restores the original normal rectangle before native maximize. A restore requested before activation cancels the deferred operation.
- A composer window-blur record does not identify the responsible executable. Another Harbor window, a dialog, another application, or a deliberate user switch can all produce it. The Windows foreground log supplies the target; its input:none field only samples selected buttons and modifiers at callback time.
- The focus guard tests exercise the X11 adapter. The Windows adapter explicitly reports that its foreground recovery guard is unavailable. Those passing tests are not evidence of Windows foreground behavior.

The regression tests execute the actual factory/startup branch with window mocks. No GUI or Electron drive was run. Actual Windows activation, monitor hotplug/DPI behavior, and the first-focus visual transition remain unverified under this audit's no-window constraint.
