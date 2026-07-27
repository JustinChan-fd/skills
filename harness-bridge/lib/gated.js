export function gatedPathFor(origPath) {
  if (/-gated\.json$/.test(origPath)) return origPath
  return origPath.replace(/\.json$/, '-gated.json')
}
export function stampManifest(artifact, { confidence, verdict, flags = [], probeResults = [] }) {
  return { ...artifact, gated: true, confidence, verdict, flags, probeResults }
}
