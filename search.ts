// A deliberately bounded Vim-pattern compiler. Unsupported Vim atoms fail
// closed instead of being silently interpreted as JavaScript regex syntax.
export function compileVimSearch(pattern: string): RegExp | null {
  let source = "";
  let magic: "magic" | "very-magic" = "magic";
  let caseFlag = "";
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] ?? "";
    if (char === "\\") {
      const next = pattern[++i];
      if (next === undefined) return null;
      if (next === "v") {
        magic = "very-magic";
        continue;
      }
      if (next === "c" || next === "C") {
        caseFlag = next === "c" ? "i" : "";
        continue;
      }
      if (
        next === "/" ||
        next === "\\" ||
        next === "." ||
        next === "*" ||
        next === "[" ||
        next === "]" ||
        next === "^" ||
        next === "$"
      ) {
        source += `\\${next}`;
        continue;
      }
      if (next === "n") {
        source += "\\n";
        continue;
      }
      if (magic === "magic" && "()+?|{}".includes(next)) {
        source += next;
        continue;
      }
      // Includes Vim word-boundaries, lookarounds, and character classes:
      // none have precisely the same meaning as their JS counterparts.
      return null;
    }
    if (char === "[") inClass = true;
    if (char === "]") inClass = false;
    if (magic === "magic" && !inClass && "()+?|{}".includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  if (inClass) return null;
  try {
    return new RegExp(source, `gm${caseFlag}u`);
  } catch {
    return null;
  }
}

export type SearchMatch = { start: number; end: number };

export function collectSearchMatches(
  text: string,
  regex: RegExp,
): SearchMatch[] {
  const matches: SearchMatch[] = [];
  regex.lastIndex = 0;
  for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
    matches.push({ start: match.index, end: match.index + match[0].length });
    // Neovim skips overlapping occurrences. Advance past empty matches too.
    if (match[0].length === 0) regex.lastIndex++;
  }
  return matches;
}

export function findSearchTarget(
  text: string,
  regex: RegExp,
  from: number,
  direction: 1 | -1,
  count = 1,
): number | null {
  return searchTargetFromMatches(
    collectSearchMatches(text, regex),
    from,
    direction,
    count,
  );
}

export function searchTargetFromMatches(
  matches: SearchMatch[],
  from: number,
  direction: 1 | -1,
  count = 1,
): number | null {
  if (matches.length === 0) return null;
  const positions = matches.map((match) => match.start);
  let position = from;
  for (let i = 0; i < count; i++) {
    const next =
      direction === 1
        ? (positions.find((index) => index > position) ?? positions[0])
        : (positions.findLast((index) => index < position) ??
          positions[positions.length - 1]);
    if (next === undefined) return null;
    position = next;
  }
  return position;
}
