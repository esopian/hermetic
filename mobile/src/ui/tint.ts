/**
 * The `selectionColor` for a multiline `TextInput`, so iOS draws its caret in
 * the given colour from the first focus.
 *
 * Why it is not just the colour: Fabric recycles text-input views, and a
 * recycled view keeps the props it last had. When a `multiline` input lands on
 * a view last used by a single-line one, `RCTTextInputComponentView` swaps in a
 * fresh `UITextView` (`_setMultiline`), and `RCTCopyBackedTextInput` does not
 * copy `tintColor` across. `selectionColor` is only re-applied when it differs
 * from the old props, so an input with the same colour as the field before it
 * kept the system-blue caret until something else re-rendered the view.
 *
 * Every single-line input passes the plain colour; multiline inputs pass this
 * one, which differs only in the alpha byte (254 of 255, invisible). A swap
 * between the two kinds therefore always changes `selectionColor` too, so the
 * new backing view gets the tint. Two inputs of the same kind never swap, and
 * the reused backing view still carries its tint.
 */
export function multilineTint(color: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? `${color}fe` : color;
}
