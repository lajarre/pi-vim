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

  older(): string {
    if (this.position + 1 < this.entries.length) this.position++;
    return this.entries[this.position] ?? this.draft;
  }

  newer(): string {
    if (this.position >= 0) this.position--;
    return this.entries[this.position] ?? this.draft;
  }
}
