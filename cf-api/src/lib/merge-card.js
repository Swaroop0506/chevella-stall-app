// Combining what was read from the two sides of a card.
//
// The front is authoritative for identity — the name, role and company are printed there
// and the back usually repeats the company at best. The back is where the address, the
// product list, branch numbers and often the GSTIN live. So the rule is simply: the front
// wins wherever it has a value, and the back fills the gaps.
//
// It is never a blind overwrite in the other direction, because a back that happens to
// carry a head-office number would otherwise replace the mobile number of the person
// actually standing in front of you.

export const MERGEABLE_FIELDS = [
  'full_name', 'designation', 'company', 'phone_primary', 'phone_secondary', 'whatsapp',
  'email', 'email_secondary', 'website', 'address', 'city', 'state', 'pincode', 'gstin',
];

function blank(v) {
  return v === null || v === undefined || String(v).trim() === '';
}

/**
 * @param {object} front parsed fields from the front (may be {})
 * @param {object} back  parsed fields from the back (may be {})
 * @returns {{merged: object, filled: object}} `filled` names the fields the back supplied,
 *          so the UI can show where a value came from.
 */
export function mergeCardFields(front = {}, back = {}) {
  const merged = { ...front };
  const filled = {};

  for (const key of MERGEABLE_FIELDS) {
    if (blank(merged[key]) && !blank(back[key])) {
      merged[key] = back[key];
      filled[key] = true;
    }
  }

  // A second phone found on the back is worth keeping even when the front had one —
  // it is usually the landline or the office line, not a duplicate.
  if (!blank(back.phone_primary)
      && back.phone_primary !== merged.phone_primary
      && blank(merged.phone_secondary)) {
    merged.phone_secondary = back.phone_primary;
    filled.phone_secondary = true;
  }

  return { merged, filled };
}

/** Confidence map for the combined result: the side that supplied a value supplies its score. */
export function mergeConfidence(frontConf = {}, backConf = {}, filled = {}) {
  const out = { ...frontConf };
  for (const key of Object.keys(filled)) {
    if (backConf[key] !== undefined) out[key] = backConf[key];
  }
  return out;
}

/**
 * Recomputed after a merge, because a back that supplies the missing phone number should
 * clear the review flag the front earned on its own.
 *
 * The bar is unchanged: a lead is only useful if you can reach the person and know who
 * they are. Anything short of that needs a human to look at the photo.
 */
export function needsReview(fields, { ocrFailed = false, imageWarnings = [] } = {}) {
  if (ocrFailed) return true;
  if (imageWarnings.includes('blurry')) return true;

  const reachable = !blank(fields.phone_primary) || !blank(fields.email);
  const identified = !blank(fields.full_name) || !blank(fields.company);
  return !(reachable && identified);
}
