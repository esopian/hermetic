# TestFlight candidate

Fill this record for the exact candidate before distributing it. These are draft notes, not a claim
that a new TestFlight build has been uploaded.

- Version / build: 0.1.0 (7)
- Git revision: 5f94785
- EAS production build UUID: 8fb15be7-b7a6-46db-b063-c79b1296126d
- Device / iOS: pending
- Acceptance record: pending

## Changes

- Hermetic app icon and branded launch artwork.
- More accessible controls, readable text and support for narrow iPhones.
- A support report that can be reviewed and shared without conversation or fleet identifiers.
- Agent narration between tool calls folds into the turn's work group.

## What to test

Agent turns in chat read differently. The short notes an agent writes between tool calls ("Let me
check X:") now fold into the turn's work group instead of sitting between one-tool rows, so a
finished turn shows one collapsed "Worked" group and then the answer.

- Ask an agent something that takes several tool calls. While it runs, the group's status line
  quotes its latest note, and the paragraph still streaming shows small and muted.
- When the turn finishes, the answer should restyle to normal text and stay outside the group.
  Open the group: notes show as muted quoted prose, tools as one-line rows, with a "N tools · M
  notes" count.
- Open or close a group while a turn is running; it should keep your choice when the turn settles.
- A turn that shares a file or kanban card should split into two groups around the card.
- Plain question-and-answer turns should look as before once they finish.

Also check that multi-fleet switching, the board and task lists from the last build still work.

## Known limitations

iPhone only. A real fleet and Tailscale membership are required. Background refresh timing is managed
by iOS. Updates arrive through TestFlight/App Store binaries. Complete the acceptance record and add
any candidate-specific issues before distributing.
