// Quality contract helpers — verbatim logic from harness-plan/workflow.js
// failsQualityContract: from :878-882 (architect revision filter) and :1247-1251 (debrief check)
// failsThinSpec: from :1256-1273 (structural validator)
// synthesizeKeyFindings: from :789-796 (validation concern key findings derivation)

// Returns true if task description fails the quality contract.
// tddRequired mirrors task.tddRequired.
export function failsQualityContract(desc, tddRequired) {
  const d = desc || ''
  return !/what/i.test(d) || !/where/i.test(d) || !/how/i.test(d) ||
         (tddRequired && !/done/i.test(d)) || !/```/.test(d)
}

// Returns true if task description is structurally thin (WHERE/HOW too short or no snippet).
export function failsThinSpec(desc) {
  const d = desc || ''
  const whereMatch = d.match(/where[:\s]+(.+?)(?=\n(?:what|how|done)|$)/is)
  const howMatch   = d.match(/how[:\s]+(.+?)(?=\n(?:what|where|done)|$)/is)
  const whereLen = (whereMatch?.[1] || '').trim().length
  const howLen   = (howMatch?.[1] || '').trim().length
  const hasSnippet = /```/.test(d)
  return whereLen < 20 || howLen < 20 || !hasSnippet
}

// Derives keyFindings from answeredQuestions for validation concerns.
// Drops "could not determine" answers; caps at 7.
export function synthesizeKeyFindings(answeredQuestions) {
  return (answeredQuestions || [])
    .filter(qa => !qa.answer?.toLowerCase().startsWith('could not determine'))
    .slice(0, 7)
    .map(qa => `${qa.question} → ${qa.answer}`)
}
