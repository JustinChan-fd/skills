// ===== PURE (mirrors workflow.js) =====
// Keep in sync with the LAYER_SCHEMA / sublayer block in workflow.js.
// Tests import from here; workflow.js inlines the same value (import() unavailable in workflow runtime).

export const LAYER_SCHEMA = {
  type: 'object',
  required: ['name', 'path', 'fileCount', 'sampleFiles', 'sublayers', 'canRunInParallel', 'dependsOnLayers'],
  properties: {
    name:             { type: 'string' },
    path:             { type: 'string' },
    fileCount:        { type: 'number' },
    sampleFiles:      { type: 'array', items: { type: 'string' }, maxItems: 5 },
    sublayers: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'path', 'fileCount', 'sampleFiles'],
        properties: {
          name:        { type: 'string' },
          path:        { type: 'string' },
          fileCount:   { type: 'number' },
          sampleFiles: { type: 'array', items: { type: 'string' }, maxItems: 5 },
        },
      },
    },
    canRunInParallel:  { type: 'boolean' },
    dependsOnLayers:   { type: 'array', items: { type: 'string' } },
  },
}
