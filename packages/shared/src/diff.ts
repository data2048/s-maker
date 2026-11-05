// Line diff (longest common subsequence) for comparing song versions.
export interface DiffLine {
  type: 'same' | 'add' | 'del';
  text: string;
}

const MAX_CELLS = 4_000_000; // ~2000 x 2000 lines

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');

  // Trim common prefix/suffix first: versions usually differ in a few lines.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const head: DiffLine[] = a.slice(0, start).map((text) => ({ type: 'same', text }));
  const tail: DiffLine[] = a.slice(endA).map((text) => ({ type: 'same', text }));
  const ma = a.slice(start, endA);
  const mb = b.slice(start, endB);

  if (ma.length * mb.length > MAX_CELLS) {
    // Too big for LCS: show as replaced block.
    return [
      ...head,
      ...ma.map((text) => ({ type: 'del' as const, text })),
      ...mb.map((text) => ({ type: 'add' as const, text })),
      ...tail,
    ];
  }

  const n = ma.length;
  const m = mb.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = ma[i] === mb[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const middle: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ma[i] === mb[j]) {
      middle.push({ type: 'same', text: ma[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      middle.push({ type: 'del', text: ma[i++]! });
    } else {
      middle.push({ type: 'add', text: mb[j++]! });
    }
  }
  while (i < n) middle.push({ type: 'del', text: ma[i++]! });
  while (j < m) middle.push({ type: 'add', text: mb[j++]! });

  return [...head, ...middle, ...tail];
}
