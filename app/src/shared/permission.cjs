'use strict';

// Measured on 2.1.288: PermissionRequest omits tool_use_id and the reason
// from a PreToolUse ask. A reason-bearing guard therefore remains native.
function permissionPrompt(input) {
  const tool = input?.tool_name;
  const data = input?.tool_input;
  const suggestions = input?.permission_suggestions;
  if (!data || ['AskUserQuestion', 'ExitPlanMode'].includes(tool)
    || !Array.isArray(suggestions) || suggestions.length !== 1) return null;

  const suggestion = suggestions[0];
  let label;
  let serverName;
  let displayTool;
  if (['Edit', 'Write'].includes(tool) && suggestion.type === 'setMode'
    && suggestion.mode === 'acceptEdits' && suggestion.destination === 'session') {
    label = 'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session';
  } else if (suggestion.type === 'addRules' && suggestion.behavior === 'allow'
    && suggestion.destination === 'localSettings' && Array.isArray(suggestion.rules)) {
    const rules = suggestion.rules;
    if (tool === 'WebFetch' && rules.length === 1 && rules[0].toolName === tool
      && /^domain:/.test(rules[0].ruleContent || '')) {
      label = `Yes, and don't ask again for ${rules[0].ruleContent.slice(7)}`;
    } else if (tool === 'Bash' && rules.length > 1 && input.cwd
      && rules.every(rule => rule.toolName === 'Bash' && typeof rule.ruleContent === 'string' && rule.ruleContent)) {
      // Native option 2 and updatedPermissions saved identical compound rules.
      // A single-command suggestion did NOT match the native prefix rule.
      const commands = rules.map(rule => JSON.stringify(rule.ruleContent));
      const joined = commands.length === 2 ? commands.join(' and ')
        : `${commands.slice(0, -1).join(', ')}, and ${commands.at(-1)}`;
      label = `Yes, and don't ask again for ${joined} commands in ${input.cwd}`;
    } else if (rules.length === 1 && rules[0].toolName === tool && !rules[0].ruleContent
      && input.mcp_server?.name && input.cwd && tool.startsWith(`mcp__${input.mcp_server.name}__`)) {
      serverName = input.mcp_server.name;
      const name = tool.slice(`mcp__${serverName}__`.length);
      displayTool = name.replace(/_+/g, ' ').trim().replace(/\b\w/g, letter => letter.toUpperCase());
      // The CLI separates server and tool with a dash; Harbor composes this
      // label itself, so it uses the same "server / Tool" form as the card.
      label = `Yes, and don't ask again for ${serverName} / ${displayTool} commands in ${input.cwd}`;
    }
  }
  // addDirectories plus setMode changed the mode unlike native option 2.
  // Unknown combinations, guard asks and plan exits must keep all native UI.
  if (!label) return null;
  return {
    toolName: tool,
    toolInput: data,
    serverName,
    displayTool,
    persistent: { label, updates: suggestions },
  };
}

module.exports = { permissionPrompt };
