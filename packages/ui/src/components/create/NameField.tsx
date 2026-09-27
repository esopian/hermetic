/** The agent name: the big mono input, the dice, and one hint line under it. */
import { randomAgentName } from "../../logic/name-dictionary.ts";
import { DiceIcon } from "./controls.tsx";
import type { CreateFormModel } from "./useCreateForm.ts";

export function NameField({ f, names }: { f: CreateFormModel; names: Set<string> }) {
  const bad = f.taken || f.invalid;
  return (
    <div className="cr-name">
      <label className="kicker" htmlFor="create-name" style={{ display: "block", marginBottom: 8 }}>
        Agent name
      </label>
      <div className="name-field">
        <input
          id="create-name"
          className="name-input"
          data-autofocus
          value={f.name}
          placeholder="e.g. corvid-2"
          aria-invalid={bad || undefined}
          onChange={(e) => f.setName(e.target.value.toLowerCase())}
          onKeyDown={(e) => {
            if (e.key === "Enter") void f.submit();
          }}
        />
        <button
          type="button"
          className="dice-btn"
          title="Roll a random name"
          aria-label="Roll a random name"
          onClick={() => f.setName(randomAgentName(names))}
        >
          <DiceIcon />
        </button>
      </div>
      <div className="name-hint" style={{ color: bad ? "var(--bad)" : "var(--fg3)" }}>
        {f.trimmed && !bad ? <span style={{ color: "var(--ok)" }}>✓ </span> : null}
        {f.nameHint}
      </div>
    </div>
  );
}
