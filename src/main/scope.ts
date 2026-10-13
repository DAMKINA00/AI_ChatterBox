// Implement scopes: path globs (relative to the project folder) a worker may write during one ask.

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");

function globToRegex(g: string): RegExp {
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      re += ".*";
      i++;
      if (g[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

/** Does a project-relative path fall inside the scope globs? A plain path covers itself and below. */
export function inScope(relPath: string, scope: string[]): boolean {
  const p = norm(relPath).toLowerCase();
  return scope.some((s0) => {
    const s = norm(s0).toLowerCase();
    if (!/[*?]/.test(s)) return p === s || p.startsWith(s + "/");
    return globToRegex(s).test(p);
  });
}

/**
 * Two implement scopes overlap when either's fixed prefix contains the other's (no scope = everything).
 * Conservative: a false overlap only makes two asks run one after another.
 */
export function scopesOverlap(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return true;
  // "src/ui/**" → "src/ui/", "src/*.js" → "src/"; a plain path stays as is.
  const prefix = (s: string) => {
    const n = norm(s).toLowerCase();
    if (!/[*?]/.test(n)) return n;
    const head = n.split(/[*?]/)[0];
    return head.slice(0, head.lastIndexOf("/") + 1);
  };
  return a.some((x) =>
    b.some((y) => {
      const px = prefix(x);
      const py = prefix(y);
      return px === "" || py === "" || px.startsWith(py) || py.startsWith(px);
    }),
  );
}
