/**
 * Validate the untrusted translation response before positional mapping.
 * Reject the whole batch when cardinality or item shape differs so one
 * missing model result can never shift translations onto later facts.
 *
 * @param {unknown} response
 * @param {number} expectedCount
 * @returns {string[] | null}
 */
export function validateTranslationBatch(response, expectedCount) {
  if (
    !Array.isArray(response) ||
    response.length !== expectedCount ||
    !response.every((value) => typeof value === 'string' && value.trim().length > 0)
  ) {
    return null;
  }
  return response;
}
