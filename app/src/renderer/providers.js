import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import {
  defaultProfileId,
  launchDefaults,
  normalizeHome as normalizeProfileHome,
  profileStyle,
  resolveProfile,
} from './profiles.cjs';

export const PROVIDERS = {
  claude: {
    label: 'Claude',
    color: '#d97757',
    logo: new URL('../../assets/logo-claude.svg', import.meta.url).href,
  },
  openai: {
    label: 'OpenAI',
    color: '#ffffff',
    logo: new URL('../../assets/logo-openai.svg', import.meta.url).href,
  },
  codex: {
    label: 'Codex',
    color: '#ffffff',
    logo: new URL('../../assets/logo-openai.svg', import.meta.url).href,
  },
  cursor: {
    label: 'Cursor',
    color: '#a78bfa',
    logo: new URL('../../assets/logo-cursor.svg', import.meta.url).href,
  },
};

export function providerIdentity(provider = 'claude') {
  return PROVIDERS[provider] || PROVIDERS.claude;
}

// The families the chip has colours for. A model Harbor knows only as a launch
// value ('opus', 'claude-opus-5') still gets its family colour, so a window
// waiting on its first message is not the one grey chip on the stage.
const MODEL_TONES = new Set(['opus', 'sonnet', 'haiku', 'fable']);

/**
 * A model chip built from a launch value rather than a transcript header.
 *
 * `label` is what the new-session registry calls it ('Opus 5' for 'opus'), so
 * the chip and the config popover cannot disagree; without one the raw value is
 * shown, never a guess and never nothing. 'default' means the account decides,
 * which nobody can name yet, so it stays null and the provider label shows.
 */
export function providerModel(modelId, label) {
  if (!modelId || modelId === 'default') return null;
  const id = String(modelId);
  const family = id.replace(/^claude-/, '').split(/[-.]/)[0].toLowerCase();
  return {
    id,
    name: label || id,
    tone: MODEL_TONES.has(family) ? family : 'other',
  };
}

export { profileStyle, resolveProfile, defaultProfileId, normalizeProfileHome, launchDefaults };

const ProfilesContext = createContext({
  profiles: [],
  // The user's own quick commands, carried on the same payload as the profiles
  // because the command bar's Workflows section has to render what THEY have.
  workflows: [],
  defaults: null,
  loaded: false,
  defaultProfileId: null,
});

export function ProfilesProvider({ children }) {
  const [state, setState] = useState({
    profiles: [],
    workflows: [],
    defaults: null,
    loaded: false,
  });

  useEffect(() => {
    let active = true;
    window.harbor.session.newOptions()
      .then((options) => {
        if (!active) return;
        const profiles = options?.profiles || [];
        setState({
          profiles,
          workflows: options?.workflows || [],
          defaults: launchDefaults(options),
          loaded: true,
        });
      })
      .catch(() => {
        if (active) setState((prev) => ({ ...prev, loaded: true }));
      });
    return () => { active = false; };
  }, []);

  const value = useMemo(() => ({
    profiles: state.profiles,
    workflows: state.workflows,
    defaults: state.defaults,
    loaded: state.loaded,
    defaultProfileId: defaultProfileId(state.profiles),
  }), [state]);

  return React.createElement(ProfilesContext.Provider, { value }, children);
}

export function useProfiles() {
  return useContext(ProfilesContext);
}

export function ProfileBadge({ profileId, profiles, className = '', title }) {
  const list = profiles || [];
  const profile = resolveProfile(list, profileId);
  if (!profile) return null;
  return React.createElement(
    'span',
    {
      className: `profile-badge${className ? ` ${className}` : ''}`,
      style: profileStyle(profile),
      title: title || profile.label,
    },
    profile.letter,
  );
}
