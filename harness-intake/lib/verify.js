// computeClaimConflict: deterministic replacement for the claimConflict boolean
// that ac-verify Haiku agents compute. Haiku occasionally miscalculates the formula
// or echoes the ticket value instead of running the grep. Pull the arithmetic out.
export function computeClaimConflict(verifiedCount, ticketClaimedCount) {
  if (!ticketClaimedCount || ticketClaimedCount <= 0) return false
  return Math.abs(verifiedCount - ticketClaimedCount) / ticketClaimedCount > 0.20
}

// recomputeClaimConflicts: apply computeClaimConflict to every AC in the list,
// returning a new array with corrected claimConflict values.
export function recomputeClaimConflicts(acList) {
  return acList.map(ac => ({
    ...ac,
    claimConflict: computeClaimConflict(ac.verifiedCount ?? 0, ac.ticketClaimedCount),
  }))
}
