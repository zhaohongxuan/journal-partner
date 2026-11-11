/** Pure parsing and guarded checkbox updates for the planning task list. */
export interface PlanningTodo {
  /** Zero-based line index in the entire document. */
  lineIndex: number;
  text: string;
  completed: boolean;
  /** Original line, including whitespace but excluding its line terminator. */
  sourceLine: string;
}

interface SourceLine {
  text: string;
  offset: number;
  visible: boolean;
}

const TASK_RE = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])\](?:[ \t]+(.*))?$/;
const HEADING_RE = /^(#{1,6})(?:[ \t]+\S.*|[ \t]*)$/;

/** Keep original character offsets so updates never normalise line endings. */
function sourceLines(content: string): SourceLine[] {
  const lines: SourceLine[] = [];
  const re = /([^\r\n]*)(\r\n|\r|\n|$)/g;
  let frontmatter = false;
  let fence = '';
  let fenceLength = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(content)) !== null) {
    if (match[0].length === 0) break;
    const text = match[1];
    const trimmed = text.trim();
    const line = { text, offset: match.index, visible: false };
    lines.push(line);

    if (lines.length === 1 && trimmed === '---') {
      frontmatter = true;
      continue;
    }
    if (frontmatter) {
      if (trimmed === '---' || trimmed === '...') frontmatter = false;
      continue;
    }
    if (fence) {
      const close = /^(`+|~+)[ \t]*$/.exec(trimmed);
      if (close && close[1][0] === fence && close[1].length >= fenceLength) {
        fence = '';
      }
      continue;
    }
    const open = /^(`{3,}|~{3,})(.*)$/.exec(trimmed);
    if (open && (open[1][0] === '~' || !open[2].includes('`'))) {
      fence = open[1][0];
      fenceLength = open[1].length;
      continue;
    }
    line.visible = true;
  }
  return lines;
}

function planningBounds(lines: SourceLine[], startHeading: string, endHeading: string): [number, number] | null {
  const start = startHeading.trim();
  const end = endHeading.trim();
  const heading = HEADING_RE.exec(start);
  if (!heading || !HEADING_RE.test(end)) return null;
  const first = lines.findIndex(line => line.visible && line.text.trim() === start);
  if (first < 0) return null;

  // An explicit end after the start takes precedence over intervening headings.
  // Only absent end markers fall back to the start heading's section boundary.
  let fallback = lines.length;
  for (let i = first + 1; i < lines.length; i++) {
    if (!lines[i].visible) continue;
    const trimmed = lines[i].text.trim();
    if (trimmed === end) return [first + 1, i];
    const next = HEADING_RE.exec(trimmed);
    if (fallback === lines.length && next && next[1].length <= heading[1].length) {
      fallback = i;
    }
  }
  return [first + 1, fallback];
}

function parseLines(lines: SourceLine[], startHeading: string, endHeading: string): PlanningTodo[] {
  const bounds = planningBounds(lines, startHeading, endHeading);
  if (!bounds) return [];
  const todos: PlanningTodo[] = [];
  for (let i = bounds[0]; i < bounds[1]; i++) {
    if (!lines[i].visible) continue;
    const match = TASK_RE.exec(lines[i].text);
    if (!match) continue;
    todos.push({
      lineIndex: i,
      text: (match[3] ?? '').trim(),
      completed: match[2] !== ' ',
      sourceLine: lines[i].text,
    });
  }
  return todos;
}

/** Parse tasks between full Markdown headings (normally ## Planning / ## Journal). */
export function parsePlanningTodos(content: string, startHeading: string, endHeading: string): PlanningTodo[] {
  return parseLines(sourceLines(content), startHeading, endHeading);
}

/** Insert a plain task without changing existing source bytes or line endings. */
export function addPlanningTodo(content: string, text: string, startHeading: string, endHeading: string): string {
  const multiline = /[\r\n\u2028\u2029]/;
  const start = startHeading.trim();
  const end = endHeading.trim();
  if (!text.trim() || multiline.test(text)) {
    throw new Error('Planning task text must be a nonblank single line.');
  }
  if (multiline.test(startHeading) || multiline.test(endHeading)
    || !HEADING_RE.test(start) || !HEADING_RE.test(end) || start === end) {
    throw new Error('Planning headings must be valid, distinct Markdown headings.');
  }

  const newline = /\r\n|\r|\n/.exec(content)?.[0] ?? '\n';
  const task = `- [ ] ${text.trim()}${newline}`;
  const lines = sourceLines(content);
  const bounds = planningBounds(lines, start, end);
  if (bounds) {
    // Inserting immediately after the heading avoids nested sections and open fences.
    const offset = lines[bounds[0]]?.offset ?? content.length;
    const separator = offset > 0 && !/[\r\n]$/.test(content.slice(0, offset)) ? newline : '';
    return content.slice(0, offset) + separator + task + content.slice(offset);
  }

  const endLine = lines.find(line => line.visible && line.text.trim() === end);
  if (endLine) {
    return content.slice(0, endLine.offset) + start + newline + task + content.slice(endLine.offset);
  }

  const separator = !content ? '' : content.endsWith(newline + newline) ? ''
    : /[\r\n]$/.test(content) ? newline : newline + newline;
  const prefix = content + separator;
  // Probe through the same scanner: a heading appended inside unclosed YAML or a
  // code fence would be hidden, so refuse to silently create an invisible task.
  const probe = sourceLines(prefix + start);
  if (!probe[probe.length - 1]?.visible) {
    throw new Error('Cannot add a planning heading inside unclosed frontmatter or a code fence.');
  }
  return prefix + start + newline + task;
}

/** Revalidate a snapshot against the current section, then replace at most one character. */
export function setPlanningTodoCompleted(
  content: string,
  todo: PlanningTodo,
  completed: boolean,
  startHeading: string,
  endHeading: string,
): string {
  const lines = sourceLines(content);
  const current = parseLines(lines, startHeading, endHeading).find(
    candidate => candidate.lineIndex === todo.lineIndex && candidate.sourceLine === todo.sourceLine,
  );
  if (!current) throw new Error('Planning task changed or is no longer in the planning section.');
  if (current.completed === completed) return content;

  const match = TASK_RE.exec(current.sourceLine);
  const offset = lines[current.lineIndex].offset + match[1].length;
  return content.slice(0, offset) + (completed ? 'x' : ' ') + content.slice(offset + 1);
}
