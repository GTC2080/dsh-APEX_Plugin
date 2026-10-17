/** Slice by UTF-16 offsets without retaining a partial character at either edge. */
export function sliceText(text, start, end) {
  return text.slice(start, end).replace(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/g, '')
}
