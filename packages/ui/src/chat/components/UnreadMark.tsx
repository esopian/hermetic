/**
 * A conversation's mark: a gold `!` when it is waiting on the operator, else a
 * dot when it has something unseen. Never a count — how many messages arrived
 * is not news, only that something did.
 */
export function UnreadMark({ needs = false }: { needs?: boolean }) {
  return needs ? (
    <span className="ch-unread needs-action">!</span>
  ) : (
    <span className="ch-unread dot" role="img" aria-label="Unread" />
  );
}
