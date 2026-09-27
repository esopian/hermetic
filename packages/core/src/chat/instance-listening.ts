/** Local opt-in monitoring preferences, scoped to a fleet and never sent to AWS. */
export interface InstanceListeningStore {
  list(fleet: string | null): string[];
  set(fleet: string | null, instance: string, listening: boolean): void;
}

export class MemoryInstanceListeningStore implements InstanceListeningStore {
  private readonly fleets = new Map<string, Set<string>>();

  list(fleet: string | null): string[] {
    return [...(this.fleets.get(fleet ?? "") ?? [])].sort();
  }

  set(fleet: string | null, instance: string, listening: boolean): void {
    const key = fleet ?? "";
    const instances = this.fleets.get(key) ?? new Set<string>();
    if (listening) instances.add(instance);
    else instances.delete(instance);
    this.fleets.set(key, instances);
  }
}
