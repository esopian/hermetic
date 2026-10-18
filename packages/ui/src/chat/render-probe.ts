/**
 * A test's window onto how often the transcript renders.
 *
 * The transcript's components are memoized so that an unchanged row is not
 * drawn again (`components/TranscriptRows.tsx`), and a memo that silently stops
 * holding — one prop handed a fresh object — costs nothing visible and a great
 * deal of work. `test/thread-render-isolation.dom.test.tsx` installs `hit` and
 * counts. Nothing in the app installs it, so in the page a render pays one
 * property read and a null check.
 */
export const renderProbe: { hit: ((component: string, id: string) => void) | null } = { hit: null };
