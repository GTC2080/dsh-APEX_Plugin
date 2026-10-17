/**
 * Public package metadata for the declarative APEX preset bundle.
 *
 * The preset is mounted by the official agent-preset and
 * agent-preset-registry plugins. APEX deliberately has no runtime installer:
 * the bundle patch is the complete installation mechanism.
 */
export const name = 'dsh-apex'
export const PRESET_ID = 'apex-v1'
export const BUNDLE_PATCH = ['./cordis.patch.yml', './presets/apex-v1/agent.cordis.yml']
