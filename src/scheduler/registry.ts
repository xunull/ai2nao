import type { ScheduledTaskDefinition } from "./types.js";

export class ScheduledTaskRegistry {
  private readonly tasks: Map<string, ScheduledTaskDefinition>;

  constructor(definitions: ScheduledTaskDefinition[]) {
    this.tasks = new Map(definitions.map((def) => [def.key, def]));
  }

  list(): ScheduledTaskDefinition[] {
    return [...this.tasks.values()];
  }

  get(taskKey: string): ScheduledTaskDefinition | null {
    return this.tasks.get(taskKey) ?? null;
  }

  has(taskKey: string): boolean {
    return this.tasks.has(taskKey);
  }
}
