// Converts the displayed (escaped) Bash code into a runnable version
export function unescapeForBash(s: string) {
  // Replace all escaped dollar signs (\$) with real ones ($)
  return s.replace(/\\\$/g, "$");
}
