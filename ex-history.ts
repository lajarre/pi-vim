/** Session-local EX history; no host editor state, persistence or side effects. */
export class ExHistory {
  private readonly entries: string[] = [];
  private position = -1;
  private draft = "";

  push(line: string): void {
    if (line.length > 0) {
      const duplicate = this.entries.indexOf(line);
      if (duplicate !== -1) this.entries.splice(duplicate, 1);
      this.entries.unshift(line);
      if (this.entries.length > 100) this.entries.pop();
    }
    this.reset();
  }

  /** Entry, cancellation and ordinary editing all start a new browse draft. */
  reset(draft = ""): void {
    this.position = -1;
    this.draft = draft;
  }

  /** Both key pairs share a position; only Up/Down filter by the saved draft. */
  older(matchingPrefix = false): string {
    for (let i = this.position + 1; i < this.entries.length; i++) {
      if (!matchingPrefix || this.entries[i].startsWith(this.draft)) {
        this.position = i;
        break;
      }
    }
    return this.entries[this.position] ?? this.draft;
  }

  newer(matchingPrefix = false): string {
    for (let i = this.position - 1; i >= 0; i--) {
      if (!matchingPrefix || this.entries[i].startsWith(this.draft)) {
        this.position = i;
        return this.entries[i];
      }
    }
    this.position = -1;
    return this.draft;
  }
}
