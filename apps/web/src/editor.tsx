import { useRef, type KeyboardEvent } from 'react';

const tokens =
  /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)|\b(true|false|null)\b/gi;

function highlight(text: string) {
  const parts = [];
  let offset = 0;
  for (const match of text.matchAll(tokens)) {
    const start = match.index;
    parts.push(text.slice(offset, start));
    const kind = match[2]
      ? 'key'
      : match[1]
        ? 'string'
        : match[3]
          ? 'number'
          : 'literal';
    parts.push(
      <span className={'token-' + kind} key={start}>
        {match[1] ?? match[0]}
      </span>,
    );
    if (match[2]) parts.push(match[2]);
    offset = start + match[0].length;
  }
  parts.push(text.slice(offset), '\n');
  return parts;
}

export function JsonEditor({
  value,
  onChange,
  invalid,
  readOnly,
}: {
  value: string;
  onChange: (text: string) => void;
  invalid: boolean;
  readOnly: boolean;
}) {
  const code = useRef<HTMLPreElement>(null);
  const gutter = useRef<HTMLPreElement>(null);
  function edit(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (readOnly) return;
    const editor = event.currentTarget;
    const { selectionStart: start, selectionEnd: end } = editor;
    const line = value.slice(value.lastIndexOf('\n', start - 1) + 1, start);
    const indentation = /^\s*/.exec(line)?.[0] ?? '';
    const insert =
      event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.altKey
        ? '  '
        : event.key === 'Enter' && indentation
          ? '\n' + indentation
          : null;
    if (insert === null) return;
    event.preventDefault();
    // Keep browser undo history when inserting indentation.
    if (!document.execCommand('insertText', false, insert)) {
      onChange(value.slice(0, start) + insert + value.slice(end));
      requestAnimationFrame(() =>
        editor.setSelectionRange(start + insert.length, start + insert.length),
      );
    }
  }
  return (
    <div className="editor">
      <pre className="gutter" aria-hidden ref={gutter}>
        {value
          .split('\n')
          .map((_, index) => index + 1)
          .join('\n')}
      </pre>
      <div className="code">
        <pre aria-hidden ref={code}>
          {highlight(value)}
        </pre>
        <textarea
          aria-label="Manifest JSON"
          aria-invalid={invalid}
          value={value}
          wrap="off"
          readOnly={readOnly}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={edit}
          onScroll={(event) => {
            if (code.current) {
              code.current.scrollTop = event.currentTarget.scrollTop;
              code.current.scrollLeft = event.currentTarget.scrollLeft;
            }
            if (gutter.current)
              gutter.current.scrollTop = event.currentTarget.scrollTop;
          }}
        />
      </div>
    </div>
  );
}
