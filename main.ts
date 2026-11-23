// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON edits) and applies it to the tree of text files rooted at the
// working directory, or applies nothing at all. SPEC.md is the whole
// contract; every behaviour below follows one of its sentences.
//
// Run as: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// Node 22, standard library only. When MAKEFUN_ENV_URL is set, the trial
// hand-over at the bottom of this file runs instead (see runner.ts).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 failure: the whole run stops with one `error: ...` line. */
class Halt extends Error {
  readonly line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

/** One edit failed: reported, rolled back, the later edits still run. */
class EditProblem extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines (SPEC section 3): split at \n, one trailing \r removed
 *  per line, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const out = text.split('\n');
  if (text.endsWith('\n')) out.pop();
  return out.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

interface FileView {
  lines: string[];
  br: string;
  tail: boolean;
}

/** Split a file's text into lines (SPEC section 3): the break is CRLF when
 *  the first line feed follows a carriage return, else LF; a trailing break
 *  means the last empty piece is not a line; an empty file has no lines. */
function splitFile(text: string): FileView {
  if (text === '') return { lines: [], br: '\n', tail: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const tail = text.endsWith(br);
  const parts = text.split(br);
  if (tail) parts.pop();
  return { lines: parts, br, tail };
}

/** Join lines back: the break between lines, a final one exactly when
 *  `tail` says so; no lines means an empty file. */
function joinFile(view: FileView): string {
  if (view.lines.length === 0) return '';
  return view.lines.join(view.br) + (view.tail ? view.br : '');
}

/** A path is safe (SPEC section 3) when it is not empty, does not start
 *  with /, holds no backslash, and no /-separated segment is empty, . or .. */
function pathIsSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** Byte order of UTF-8 paths, for the output rows. */
function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const stripTailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/**
 * The tree as the edits leave it. `base` lazily remembers what each path
 * held on disk before the run (null: no such file); `next` holds the paths
 * the edits changed (null: deleted). `moves` records the successful move
 * edits, so the final output can print one R line for each.
 */
class WorkTree {
  private readonly base = new Map<string, string | null>();
  readonly next = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];

  before(p: string): string | null {
    if (!this.base.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.base.set(p, v);
    }
    return this.base.get(p) as string | null;
  }

  current(p: string): string | null {
    return this.next.has(p) ? (this.next.get(p) as string | null) : this.before(p);
  }

  put(p: string, v: string | null): void {
    this.next.set(p, v);
  }

  snapshot(): { next: Map<string, string | null>; moves: Array<[string, string]> } {
    return { next: new Map(this.next), moves: this.moves.slice() };
  }

  restore(s: { next: Map<string, string | null>; moves: Array<[string, string]> }): void {
    this.next.clear();
    for (const [k, v] of s.next) this.next.set(k, v);
    this.moves.length = 0;
    for (const m of s.moves) this.moves.push(m);
  }
}

type EditFn = (tree: WorkTree) => void;

/* ------------------------------------------------------------------ */
/* Matching lines (SPEC section 5)                                     */
/* ------------------------------------------------------------------ */

/** One line of an old block or a new block. `ctx` marks a context line:
 *  a line of both O and N, written as the file's own matched line. */
interface BlockLine {
  text: string;
  ctx: boolean;
}

/** Does O match the file's lines at position `at`, at one tier? */
function matchesAt(fileLines: string[], oldBlock: BlockLine[], tier: number, at: number): boolean {
  if (at < 0 || at + oldBlock.length > fileLines.length) return false;
  for (let k = 0; k < oldBlock.length; k += 1) {
    const a = fileLines[at + k] as string;
    const b = oldBlock[k]!.text;
    if (tier === 0) {
      if (a !== b) return false;
    } else if (tier === 1) {
      if (stripTailWs(a) !== stripTailWs(b)) return false;
    } else if (stripBothWs(a) !== stripBothWs(b)) {
      return false;
    }
  }
  return true;
}

/** Every start position (occurrences may overlap) where O occurs at a
 *  tier, at or after `from`. */
function occurrencesAt(fileLines: string[], oldBlock: BlockLine[], tier: number, from: number): number[] {
  const out: number[] = [];
  const last = fileLines.length - oldBlock.length;
  for (let at = Math.max(0, from); at <= last; at += 1) {
    if (matchesAt(fileLines, oldBlock, tier, at)) out.push(at);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which O
 *  occurs at least once at or after `from`, with its positions. */
function firstTierWith(
  fileLines: string[],
  oldBlock: BlockLine[],
  strict: boolean,
  from: number,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions = occurrencesAt(fileLines, oldBlock, tier, from);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** Build the lines that replace a matched block: context lines come from
 *  the file's own matched lines; every other line of N is re-indented at
 *  tier 2 (F = leading whitespace of the file's first matched line, P =
 *  leading whitespace of O's first line). */
function replacementLines(
  fileLines: string[],
  at: number,
  oldBlock: BlockLine[],
  newBlock: BlockLine[],
  tier: number,
): string[] {
  const out: string[] = [];
  // The k-th context line of N answers the k-th context line of O.
  let ctxSeen = 0;
  const fileLineForCtx = (wanted: number): string => {
    let seen = 0;
    for (let k = 0; k < oldBlock.length; k += 1) {
      if (!oldBlock[k]!.ctx) continue;
      if (seen === wanted) return fileLines[at + k] as string;
      seen += 1;
    }
    return '';
  };
  const firstFile = fileLines[at] ?? '';
  const firstOld = oldBlock.length > 0 ? oldBlock[0]!.text : '';
  const fLead = leadWs(firstFile);
  const pLead = leadWs(firstOld);
  for (const entry of newBlock) {
    if (entry.ctx) {
      out.push(fileLineForCtx(ctxSeen));
      ctxSeen += 1;
      continue;
    }
    let text = entry.text;
    if (tier === 2 && text !== '' && text.trim() !== '' && text.startsWith(pLead)) {
      text = fLead + text.slice(pLead.length);
    }
    out.push(text);
  }
  return out;
}

/** Replace the k matched lines at `at` with the new block's lines. */
function spliceBlock(
  fileLines: string[],
  at: number,
  oldBlock: BlockLine[],
  newBlock: BlockLine[],
  tier: number,
): string[] {
  const made = replacementLines(fileLines, at, oldBlock, newBlock, tier);
  return [...fileLines.slice(0, at), ...made, ...fileLines.slice(at + oldBlock.length)];
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC section 6)                                      */
/* ------------------------------------------------------------------ */

/** One body line of a hunk: ' ' context, '-' old, '+' new, '\' a
 *  backslash line that refers to the body line before it. */
interface BodyLine {
  kind: string;
  text: string;
}

interface Hunk {
  oldStart: number;
  body: BodyLine[];
}

interface DiffSection {
  gitOld: string | null;
  gitNew: string | null;
  headOld: string | null;
  headNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

/** A `--- ` / `+++ ` path: text after the four characters, up to the first
 *  tab, surrounding spaces removed; /dev/null means no file; a leading
 *  a/ or b/ is removed. */
function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Read one hunk starting at lines[i] (an @@ line). Returns the hunk and
 *  the index just past its body. Empty lines at the end of a body are not
 *  part of it. */
function readHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = HUNK_HEAD.exec(lines[i] as string);
  if (m === null) throw new Halt(`error: parse ${i + 1}`);
  const body: BodyLine[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j] as string;
    // A --- line followed by a +++ line ends the body (it starts a new
    // section), even though it starts with -.
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') body.push({ kind: ' ', text: '' });
    else if (l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push({ kind: l[0] as string, text: l.slice(1) });
    } else break;
    j += 1;
  }
  while (body.length > 0) {
    const last = body[body.length - 1] as BodyLine;
    if (last.kind === ' ' && last.text === '') body.pop();
    else break;
  }
  return { hunk: { oldStart: Number(m[1]), body }, next: j };
}

/** Does a `\` line follow the hunk's last context or `+` line? */
function backslashAfterLastKept(hunk: Hunk): boolean {
  for (let k = hunk.body.length - 1; k >= 0; k -= 1) {
    const kind = (hunk.body[k] as BodyLine).kind;
    if (kind === ' ' || kind === '+') {
      const after = hunk.body[k + 1];
      return after !== undefined && after.kind === '\\';
    }
  }
  return false;
}

/** Split a hunk body into its old block O (context + `-`) and new block N
 *  (context + `+`), in body order. */
function hunkBlocks(hunk: Hunk): { oldBlock: BlockLine[]; newBlock: BlockLine[] } {
  const oldBlock: BlockLine[] = [];
  const newBlock: BlockLine[] = [];
  for (const entry of hunk.body) {
    if (entry.kind === ' ') {
      oldBlock.push({ text: entry.text, ctx: true });
      newBlock.push({ text: entry.text, ctx: true });
    } else if (entry.kind === '-') {
      oldBlock.push({ text: entry.text, ctx: false });
    } else if (entry.kind === '+') {
      newBlock.push({ text: entry.text, ctx: false });
    }
  }
  return { oldBlock, newBlock };
}

/** Parse a unified patch into one edit per section. */
function parseUnified(lines: string[], strict: boolean): EditFn[] {
  const sections: DiffSection[] = [];
  let cur: DiffSection | null = null;
  let inHeader = false;
  let hasPair = false;

  const openGit = (oldP: string, newP: string): void => {
    if (cur !== null) sections.push(cur);
    cur = {
      gitOld: oldP, gitNew: newP, headOld: null, headNew: null,
      renameOld: null, renameNew: null, create: false, remove: false, hunks: [],
    };
    inHeader = true;
    hasPair = false;
  };
  const openPair = (oldP: string | null, newP: string | null): void => {
    if (cur !== null) sections.push(cur);
    cur = {
      gitOld: null, gitNew: null, headOld: oldP, headNew: newP,
      renameOld: null, renameNew: null, create: false, remove: false, hunks: [],
    };
    inHeader = true;
    hasPair = true;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    const next = i + 1 < lines.length ? (lines[i + 1] as string) : '';
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (m === null) throw new Halt(`error: parse ${i + 1}`);
      openGit(m[1] as string, m[2] as string);
      i += 1;
      continue;
    }
    if (cur === null) {
      if (line.startsWith('@@')) throw new Halt(`error: parse ${i + 1}`);
      if (line.startsWith('--- ') && next.startsWith('+++ ')) {
        openPair(headerPath(line), headerPath(next));
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (inHeader) {
      if (line.startsWith('@@')) {
        const got = readHunk(lines, i);
        cur.hunks.push(got.hunk);
        inHeader = false;
        i = got.next;
        continue;
      }
      if (line.startsWith('--- ')) {
        if (!next.startsWith('+++ ')) throw new Halt(`error: parse ${i + 2}`);
        if (hasPair) {
          openPair(headerPath(line), headerPath(next));
          i += 2;
          continue;
        }
        cur.headOld = headerPath(line);
        cur.headNew = headerPath(next);
        hasPair = true;
        i += 2;
        continue;
      }
      if (line.startsWith('+++ ')) {
        cur.headNew = headerPath(line);
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameOld = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameNew = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.create = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.remove = true;
        i += 1;
        continue;
      }
      // index, old mode, new mode, similarity, dissimilarity, Index: and
      // any other header line are ignored.
      i += 1;
      continue;
    }
    // Past the first hunk: further @@ lines are new hunks, a ---/+++ pair
    // or a diff --git line starts a new section, the rest is ignored.
    if (line.startsWith('@@')) {
      const got = readHunk(lines, i);
      cur.hunks.push(got.hunk);
      i = got.next;
      continue;
    }
    if (line.startsWith('--- ') && next.startsWith('+++ ')) {
      openPair(headerPath(line), headerPath(next));
      i += 2;
      continue;
    }
    i += 1;
  }
  if (cur !== null) sections.push(cur);

  return sections.map((section) => unifiedEdit(section, strict));
}

/** One section is one edit. */
function unifiedEdit(section: DiffSection, strict: boolean): EditFn {
  const oldPath = section.headOld ?? section.renameOld ?? section.gitOld;
  const newPath = section.headNew ?? section.renameNew ?? section.gitNew;
  const isCreate = section.create || oldPath === null;
  const isDelete = !isCreate && (section.remove || newPath === null);
  const isMove = !isCreate && !isDelete && oldPath !== newPath;

  if (isCreate) {
    const target = newPath ?? '';
    return (tree) => {
      if (!pathIsSafe(target)) throw new EditProblem('unsafe', target);
      if (tree.current(target) !== null) throw new EditProblem('exists', target);
      const plus: string[] = [];
      let lastPlusNoTail = false;
      for (const hunk of section.hunks) {
        for (let k = 0; k < hunk.body.length; k += 1) {
          const entry = hunk.body[k] as BodyLine;
          if (entry.kind === '+') {
            plus.push(entry.text);
            const after = hunk.body[k + 1];
            lastPlusNoTail = after !== undefined && after.kind === '\\';
          }
        }
      }
      // A created file ends with a line break unless a backslash follows
      // its last + line.
      tree.put(target, plus.length === 0 ? '' : plus.join('\n') + (lastPlusNoTail ? '' : '\n'));
    };
  }

  return (tree) => {
    const from = oldPath as string;
    if (!pathIsSafe(from)) throw new EditProblem('unsafe', from);
    if (isMove || isDelete) {
      const to = newPath as string;
      if (isMove && !pathIsSafe(to)) throw new EditProblem('unsafe', to);
    }
    const beforeText = tree.current(from);
    if (beforeText === null) throw new EditProblem('missing', from);
    if (isDelete) {
      tree.put(from, null);
      return;
    }
    if (isMove) {
      const to = newPath as string;
      if (tree.current(to) !== null) throw new EditProblem('exists', to);
    }
    const view = splitFile(beforeText);
    let lines = view.lines;
    let tail = view.tail;
    let d = 0;
    for (const hunk of section.hunks) {
      const { oldBlock, newBlock } = hunkBlocks(hunk);
      if (oldBlock.length === 0) {
        const at = Math.min(hunk.oldStart + d, lines.length);
        const made = replacementLines(lines, at, oldBlock, newBlock, 0);
        lines = [...lines.slice(0, at), ...made, ...lines.slice(at)];
        if (made.length > 0 && at + made.length === lines.length) {
          // insertion landed at the end: the result ends with a break
          // unless a backslash follows the hunk's last + line
          if (backslashAfterLastKept(hunk)) tail = false;
          else tail = true;
        }
      } else {
        const found = firstTierWith(lines, oldBlock, strict, 0);
        if (found === null) throw new EditProblem('no-match', from);
        const target = hunk.oldStart - 1 + d;
        let best = found.positions[0] as number;
        for (const pos of found.positions) {
          if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
        }
        const touchesEnd = best + oldBlock.length === lines.length;
        lines = spliceBlock(lines, best, oldBlock, newBlock, found.tier);
        if (touchesEnd) tail = !backslashAfterLastKept(hunk);
      }
      d += newBlock.length - oldBlock.length;
    }
    const result: FileView = { lines, br: view.br, tail };
    if (isMove) {
      const to = newPath as string;
      tree.put(to, joinFile(result));
      tree.put(from, null);
      tree.moves.push([from, to]);
    } else {
      tree.put(from, joinFile(result));
    }
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC section 7)                              */
/* ------------------------------------------------------------------ */

const SR_SEARCH = '<<<<<<< SEARCH';
const SR_MID = '=======';
const SR_END = '>>>>>>> REPLACE';

/** Parse SEARCH/REPLACE blocks into one edit per block. */
function parseSearchReplace(lines: string[], strict: boolean): EditFn[] {
  const edits: EditFn[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  for (let s = 0; s < lines.length; s += 1) {
    if ((lines[s] as string).trimEnd() !== SR_SEARCH) continue;
    // The path is the nearest line before SEARCH, after the previous
    // block's REPLACE (or the start of the patch), that is not blank and
    // does not start with three backticks once trimmed.
    let path: string | null = null;
    for (let k = s - 1; k > prevEnd; k -= 1) {
      const cand = lines[k] as string;
      if (isBlank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Halt(`error: parse ${s + 1}`);
    // The ======= line, then the >>>>>>> REPLACE line, after SEARCH.
    let mid = -1;
    for (let k = s + 1; k < lines.length; k += 1) {
      const l = (lines[k] as string).trimEnd();
      if (l === SR_SEARCH) break;
      if (l === SR_MID) {
        mid = k;
        break;
      }
    }
    if (mid < 0) throw new Halt(`error: parse ${s + 1}`);
    let end = -1;
    for (let k = mid + 1; k < lines.length; k += 1) {
      const l = (lines[k] as string).trimEnd();
      if (l === SR_SEARCH) break;
      if (l === SR_END) {
        end = k;
        break;
      }
    }
    if (end < 0) throw new Halt(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, mid);
    const newLines = lines.slice(mid + 1, end);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = end;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): EditFn {
  return (tree) => {
    if (!pathIsSafe(path)) throw new EditProblem('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.current(path) !== null) throw new EditProblem('exists', path);
      tree.put(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const beforeText = tree.current(path);
    if (beforeText === null) throw new EditProblem('missing', path);
    const view = splitFile(beforeText);
    const oldBlock: BlockLine[] = oldLines.map((t) => ({ text: t, ctx: false }));
    const newBlock: BlockLine[] = newLines.map((t) => ({ text: t, ctx: false }));
    const found = firstTierWith(view.lines, oldBlock, strict, 0);
    if (found === null) throw new EditProblem('no-match', path);
    if (found.positions.length > 1) throw new EditProblem('ambiguous', path);
    const at = found.positions[0] as number;
    const made = spliceBlock(view.lines, at, oldBlock, newBlock, found.tier);
    tree.put(path, joinFile({ lines: made, br: view.br, tail: view.tail }));
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC section 8)                                        */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface V4aSection {
  kind: string;
  path: string;
  pathLine: number;
  raw: Array<{ text: string; no: number }>;
}

/** Parse a V4A patch into one edit per section. */
function parseV4a(lines: string[], strict: boolean): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Halt('error: parse 1');
  if ((lines[first] as string).trim() !== '*** Begin Patch') {
    throw new Halt(`error: parse ${first + 1}`);
  }
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!isBlank(lines[k] as string)) {
      last = k;
      break;
    }
  }
  if ((lines[last] as string).trim() !== '*** End Patch') {
    throw new Halt(`error: parse ${lines.length + 1}`);
  }
  const sections: V4aSection[] = [];
  let cur: V4aSection | null = null;
  for (let i = first + 1; i < last; i += 1) {
    const line = lines[i] as string;
    if (line.startsWith('*** Add File: ')) {
      if (cur !== null) sections.push(cur);
      cur = { kind: 'add', path: line.slice('*** Add File: '.length).trim(), pathLine: i + 1, raw: [] };
    } else if (line.startsWith('*** Delete File: ')) {
      if (cur !== null) sections.push(cur);
      cur = { kind: 'delete', path: line.slice('*** Delete File: '.length).trim(), pathLine: i + 1, raw: [] };
    } else if (line.startsWith('*** Update File: ')) {
      if (cur !== null) sections.push(cur);
      cur = { kind: 'update', path: line.slice('*** Update File: '.length).trim(), pathLine: i + 1, raw: [] };
    } else if (cur === null) {
      if (isBlank(line)) continue;
      throw new Halt(`error: parse ${i + 1}`);
    } else {
      cur.raw.push({ text: line, no: i + 1 });
    }
  }
  if (cur !== null) sections.push(cur);

  const edits: EditFn[] = [];
  for (const section of sections) {
    // Blank lines at the end of a section are not part of it.
    while (section.raw.length > 0 && isBlank(section.raw[section.raw.length - 1]!.text)) {
      section.raw.pop();
    }
    if (section.kind === 'add') {
      const content: string[] = [];
      for (const r of section.raw) {
        if (r.text.startsWith('+')) content.push(r.text.slice(1));
        else if (r.text === '') content.push('');
        else throw new Halt(`error: parse ${r.no}`);
      }
      edits.push(v4aAddEdit(section.path, content));
    } else if (section.kind === 'delete') {
      for (const r of section.raw) {
        if (!isBlank(r.text)) throw new Halt(`error: parse ${r.no}`);
      }
      edits.push(v4aDeleteEdit(section.path));
    } else {
      edits.push(v4aUpdateEdit(section, strict));
    }
  }
  return edits;
}

function v4aAddEdit(path: string, content: string[]): EditFn {
  return (tree) => {
    if (!pathIsSafe(path)) throw new EditProblem('unsafe', path);
    if (tree.current(path) !== null) throw new EditProblem('exists', path);
    tree.put(path, content.length === 0 ? '' : content.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): EditFn {
  return (tree) => {
    if (!pathIsSafe(path)) throw new EditProblem('unsafe', path);
    if (tree.current(path) === null) throw new EditProblem('missing', path);
    tree.put(path, null);
  };
}

function v4aUpdateEdit(section: V4aSection, strict: boolean): EditFn {
  let moveTo: string | null = null;
  const chunks: V4aChunk[] = [];
  let curChunk: V4aChunk | null = null;
  for (const r of section.raw) {
    const line = r.text;
    if (line.startsWith('*** Move to: ')) {
      if (moveTo !== null || chunks.length > 0) throw new Halt(`error: parse ${r.no}`);
      moveTo = line.slice('*** Move to: '.length).trim();
    } else if (line.startsWith('@@')) {
      curChunk = { anchor: line.slice(2).trim(), eof: false, body: [] };
      chunks.push(curChunk);
    } else if (line === '*** End of File') {
      if (curChunk === null) throw new Halt(`error: parse ${r.no}`);
      curChunk.eof = true;
      curChunk = null;
    } else if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
      if (curChunk === null) {
        curChunk = { anchor: null, eof: false, body: [] };
        chunks.push(curChunk);
      }
      curChunk.body.push({ kind: line === '' ? ' ' : (line[0] as string), text: line === '' ? '' : line.slice(1) });
    } else {
      throw new Halt(`error: parse ${r.no}`);
    }
  }
  if (chunks.length === 0 && moveTo === null) {
    throw new Halt(`error: parse ${section.pathLine}`);
  }
  const from = section.path;
  const to = moveTo;
  return (tree) => {
    if (!pathIsSafe(from)) throw new EditProblem('unsafe', from);
    if (to !== null && !pathIsSafe(to)) throw new EditProblem('unsafe', to);
    const beforeText = tree.current(from);
    if (beforeText === null) throw new EditProblem('missing', from);
    if (to !== null && tree.current(to) !== null) throw new EditProblem('exists', to);
    const view = splitFile(beforeText);
    let lines = view.lines;
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const anchorBlock: BlockLine[] = [{ text: chunk.anchor, ctx: false }];
        const found = firstTierWith(lines, anchorBlock, strict, cursor);
        if (found === null) throw new EditProblem('no-match', from);
        cursor = (found.positions[0] as number) + 1;
      }
      const oldBlock: BlockLine[] = [];
      const newBlock: BlockLine[] = [];
      for (const entry of chunk.body) {
        if (entry.kind === ' ') {
          oldBlock.push({ text: entry.text, ctx: true });
          newBlock.push({ text: entry.text, ctx: true });
        } else if (entry.kind === '-') {
          oldBlock.push({ text: entry.text, ctx: false });
        } else if (entry.kind === '+') {
          newBlock.push({ text: entry.text, ctx: false });
        }
      }
      if (oldBlock.length === 0) {
        const at = chunk.eof ? lines.length : cursor;
        const made = replacementLines(lines, at, oldBlock, newBlock, 0);
        lines = [...lines.slice(0, at), ...made, ...lines.slice(at)];
        cursor = at + made.length;
        continue;
      }
      // First tier with an occurrence at or after the cursor; an
      // end-of-file chunk takes only one ending at the file's last line.
      let picked: { tier: number; at: number } | null = null;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const tier of tiers) {
        const positions = occurrencesAt(lines, oldBlock, tier, cursor).filter(
          (pos) => !chunk.eof || pos + oldBlock.length === lines.length,
        );
        if (positions.length > 0) {
          picked = { tier, at: positions[0] as number };
          break;
        }
      }
      if (picked === null) throw new EditProblem('no-match', from);
      lines = spliceBlock(lines, picked.at, oldBlock, newBlock, picked.tier);
      cursor = picked.at + newBlock.length;
    }
    const result = joinFile({ lines, br: view.br, tail: view.tail });
    if (to !== null) {
      tree.put(to, result);
      tree.put(from, null);
      tree.moves.push([from, to]);
    } else {
      tree.put(from, result);
    }
  };
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC section 9)                                         */
/* ------------------------------------------------------------------ */

/** Validate one edit object; null when it is not one. */
function jsonEditObject(v: unknown): EditFn | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const needFile = (tree: WorkTree): string => {
    if (!pathIsSafe(p)) throw new EditProblem('unsafe', p);
    const t = tree.current(p);
    if (t === null) throw new EditProblem('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!pathIsSafe(p)) throw new EditProblem('unsafe', p);
      if (tree.current(p) !== null) throw new EditProblem('exists', p);
      tree.put(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = needFile(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const flat = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = flat(before);
      const oldFlat = flat(oldStr);
      let count = 0;
      for (let k = text.indexOf(oldFlat); k >= 0; k = text.indexOf(oldFlat, k + 1)) count += 1;
      if (count === 0) throw new EditProblem('no-match', p);
      if (count > 1) throw new EditProblem('ambiguous', p);
      const at = text.indexOf(oldFlat);
      const out = text.slice(0, at) + flat(newStr) + text.slice(at + oldFlat.length);
      tree.put(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const atLine = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = needFile(tree);
      const view = splitFile(before);
      if (atLine < 0 || atLine > view.lines.length) throw new EditProblem('no-match', p);
      const lines = [...view.lines];
      lines.splice(atLine, 0, ...add);
      tree.put(p, joinFile({ lines, br: view.br, tail: view.tail }));
    };
  }
  return null;
}

/** Parse a JSON patch: one array of edit objects, or JSON Lines. */
function parseJson(text: string, lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Halt('error: parse 1');
  const edits: EditFn[] = [];
  if ((lines[first] as string).trimStart().startsWith('[')) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Halt(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(value)) throw new Halt(`error: parse ${first + 1}`);
    for (const item of value) {
      const edit = jsonEditObject(item);
      if (edit === null) throw new Halt(`error: parse ${first + 1}`);
      edits.push(edit);
    }
    return edits;
  }
  lines.forEach((line, i) => {
    if (isBlank(line)) return;
    let edit: EditFn | null = null;
    try {
      edit = jsonEditObject(JSON.parse(line));
    } catch {
      edit = null;
    }
    if (edit === null) throw new Halt(`error: parse ${i + 1}`);
    edits.push(edit);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Format detection (SPEC section 4)                                   */
/* ------------------------------------------------------------------ */

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if ((lines[first] as string).trim() === '*** Begin Patch') return 'v4a';
  const c = (lines[first] as string).trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === SR_SEARCH)) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Invocation, output and exit codes (SPEC sections 1, 2 and 10)       */
/* ------------------------------------------------------------------ */

interface RunOutcome {
  code: number;
  out: string[];
}

/** Parse the command line. A usage error is: an unknown dash argument
 *  before --, an option given twice, a --format value outside the five
 *  names, or more than one positional argument. */
function parseArgs(args: string[]): { format: string; check: boolean; strict: boolean; patch: string | null } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        const value = a.slice('--format='.length);
        if (format !== null || !FORMAT_NAMES.includes(value)) throw new Halt('error: usage');
        format = value;
      } else if (a === '--check') {
        if (check) throw new Halt('error: usage');
        check = true;
      } else if (a === '--strict') {
        if (strict) throw new Halt('error: usage');
        strict = true;
      } else {
        throw new Halt('error: usage');
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) throw new Halt('error: usage');
  const patch = pos.length === 0 || pos[0] === '-' ? null : (pos[0] as string);
  return { format: format ?? 'auto', check, strict, patch };
}

function execute(args: string[]): RunOutcome {
  let opts;
  try {
    opts = parseArgs(args);
  } catch (e) {
    if (e instanceof Halt) return { code: 2, out: [e.line] };
    throw e;
  }
  let text = '';
  try {
    text = readFileSync(opts.patch ?? 0, 'utf8');
  } catch {
    if (opts.patch !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = opts.format === 'auto' ? detectFormat(lines) : opts.format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: EditFn[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, opts.strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, opts.strict);
    else edits = parseV4a(lines, opts.strict);
    if (edits.length === 0) throw new Halt('error: parse 1');
  } catch (e) {
    if (e instanceof Halt) return { code: 2, out: [e.line] };
    throw e;
  }

  const tree = new WorkTree();
  const problems: EditProblem[] = [];
  for (const edit of edits) {
    const snap = tree.snapshot();
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditProblem)) throw e;
      tree.restore(snap);
      problems.push(e);
    }
  }
  if (problems.length > 0) {
    return {
      code: 1,
      out: [...problems.map((f) => `error: ${f.code} ${f.path}`), `failed: ${problems.length} of ${edits.length} edits`],
    };
  }

  // One row per path whose state changed, in byte order; a successful
  // move prints one R line (sorted by its new path) instead of a D and
  // an A line.
  const rows: Array<{ key: string; line: string }> = [];
  for (const p of tree.next.keys()) {
    const was = tree.before(p);
    const now = tree.next.get(p) as string | null;
    if (was === now) continue;
    if (was === null) rows.push({ key: p, line: `A ${p}` });
    else if (now === null) rows.push({ key: p, line: `D ${p}` });
    else rows.push({ key: p, line: `M ${p}` });
  }
  for (const [oldP, newP] of tree.moves) {
    if (tree.before(oldP) !== null && tree.current(oldP) === null && tree.before(newP) === null && tree.current(newP) !== null) {
      const dAt = rows.findIndex((r) => r.line === `D ${oldP}`);
      const aAt = rows.findIndex((r) => r.line === `A ${newP}`);
      if (dAt >= 0 && aAt >= 0) {
        rows.splice(Math.max(dAt, aAt), 1);
        rows.splice(Math.min(dAt, aAt), 1);
        rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      }
    }
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));

  if (!opts.check) {
    for (const row of rows) {
      const p = row.line.startsWith('R ')
        ? (row.line.slice(2).split(' -> ')[1] as string)
        : row.line.slice(2);
      // The row's path is the one to write or delete; for R it is the
      // new path, which the tree holds as created.
      const state = tree.current(p);
      if (row.line.startsWith('D ')) {
        rmSync(row.line.slice(2), { force: true });
      } else if (state !== null) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, state);
      }
    }
    // A move's old path is deleted above through its D row; when the
    // move became an R row, delete the old path here.
    for (const [oldP, newP] of tree.moves) {
      if (tree.before(oldP) !== null && tree.current(oldP) === null && tree.before(newP) === null && tree.current(newP) !== null) {
        rmSync(oldP, { force: true });
      }
    }
  }
  const n = rows.length;
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${n} ${n === 1 ? 'file' : 'files'}`] };
}

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this
  // file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(envUrl);
} else {
  const result = execute(process.argv.slice(2));
  writeSync(1, result.out.map((l) => `${l}\n`).join(''));
  process.exitCode = result.code;
}
