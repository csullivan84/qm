function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inlineMarkdown(value: string): string {
  const tokens: string[] = [];
  const token = (html: string): string => {
    const marker = `\u0000${tokens.length}\u0000`;
    tokens.push(html);
    return marker;
  };
  let prepared = value.replace(
    /\[([^\]\n]+)\]\(([^\s)]+(?:\([^)]*\))?)\)/g,
    (_match, label: string, rawUrl: string) => {
      let url: URL;
      try {
        url = new URL(rawUrl);
      } catch {
        return label;
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") return label;
      return token(`<a href="${escapeHtml(url.toString())}">${escapeHtml(label)}</a>`);
    },
  );
  prepared = prepared.replace(/`([^`\n]+)`/g, (_match, code: string) => token(`<code>${escapeHtml(code)}</code>`));
  prepared = escapeHtml(prepared)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/_([^_\n]+)_/g, "<em>$1</em>");
  return prepared.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => tokens[Number(index)] ?? "");
}

export function matrixFormattedBody(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const output: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  const flushParagraph = (): void => {
    if (!paragraph.length) return;
    output.push(`<p>${paragraph.map(inlineMarkdown).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = (): void => {
    if (!list.length) return;
    output.push(`<ul>${list.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</ul>`);
    list = [];
  };
  for (const line of lines) {
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1]!.length;
      output.push(`<h${level}>${inlineMarkdown(heading[2]!)}</h${level}>`);
    } else if (bullet) {
      flushParagraph();
      list.push(bullet[1]!);
    } else if (!line.trim()) {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  return output.join("");
}
