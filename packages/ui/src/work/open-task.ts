import { createContext, useContext } from "react";

/**
 * How any part of the page opens a kanban task drawer: the chat widget, a
 * Hermes notice row, a matrix card. `App` provides the real opener; the
 * default is a no-op so a component renders the same without a WORK view.
 */
export interface OpenKanbanTask {
  open: (instance: string, taskId: string) => void;
}

export const OpenKanbanTaskContext = createContext<OpenKanbanTask>({ open: () => {} });

export function useOpenKanbanTask(): OpenKanbanTask {
  return useContext(OpenKanbanTaskContext);
}
