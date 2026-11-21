// Renders model-written and platform-written text: Markdown with real mathematics, and ledger references such as
// [[C3]] as chips that open the item. Raw HTML is never rendered and remote images are never fetched, because
// everything a model or a retrieved page wrote is untrusted.
import { createContext, memo, useContext, useMemo, type ReactNode } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

export interface RefLookup {
  open: (id: string) => void;
  /** A one-line description of the item, or undefined when the run has no such item. */
  describe: (id: string) => string | undefined;
}

const RefContext = createContext<RefLookup | null>(null);
export const RefProvider = RefContext.Provider;
export const useRefs = (): RefLookup | null => useContext(RefContext);

/** A reference to one item of the run's ledger. It is a button only when the item really exists. */
export function Ref({ id, children }: { id: string; children?: ReactNode }) {
  const look = useContext(RefContext);
  const title = look?.describe(id);
  if (!look || title === undefined) {
    return (
      <span className="ref opacity-60" title="Not found in this run's ledger">
        {children ?? id}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="ref"
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        look.open(id);
      }}
    >
      {children ?? id}
    </button>
  );
}

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

const TOKEN = /\[\[([A-Z]\d+|(?:lead|sub)-[\w-]+)\]\]/g;

/** Turns reference tokens in ordinary text into links. Code and mathematics are different node types and stay untouched. */
function linkRefs(node: MdNode): void {
  if (!node.children) return;
  const out: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && child.value && child.value.includes("[[")) {
      const text = child.value;
      let last = 0;
      for (const m of text.matchAll(TOKEN)) {
        const at = m.index ?? 0;
        if (at > last) out.push({ type: "text", value: text.slice(last, at) });
        out.push({ type: "link", url: `#ref-${m[1]}`, children: [{ type: "text", value: m[1] }] });
        last = at + m[0].length;
      }
      if (last < text.length) out.push({ type: "text", value: text.slice(last) });
    } else {
      if (child.type !== "link" && child.type !== "code" && child.type !== "inlineCode") linkRefs(child);
      out.push(child);
    }
  }
  node.children = out;
}

const remarkRefs = () => (tree: MdNode): void => linkRefs(tree);

/** Models often write \( … \) and \[ … \]; the Markdown reader only knows dollar signs. Code is left alone. */
export function normalizeMath(src: string): string {
  if (!src.includes("\\(") && !src.includes("\\[")) return src;
  return src
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(/(?<!\\)\\\[([\s\S]+?)(?<!\\)\\\]/g, (_m, body: string) => `\n$$\n${body.trim()}\n$$\n`).replace(/(?<!\\)\\\(([\s\S]+?)(?<!\\)\\\)/g, (_m, body: string) => `$${body.trim()}$`),
    )
    .join("");
}

const ID = /^(?:[ACEIKLMNOQRSTUVX]\d+|(?:lead|sub)-[\w-]+)$/;

/** The report prints the ids of ledger items in bold; one that really exists in this run becomes a reference. */
function Strong({ children }: { children?: ReactNode }) {
  const look = useContext(RefContext);
  if (look && typeof children === "string" && ID.test(children) && look.describe(children) !== undefined) return <Ref id={children} />;
  return <strong>{children}</strong>;
}

const COMPONENTS: Components = {
  strong({ children }) {
    return <Strong>{children}</Strong>;
  },
  a({ href, children }) {
    if (href?.startsWith("#ref-")) return <Ref id={href.slice(5)} />;
    if (href && /^(https?:|mailto:)/i.test(href)) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer nofollow">
          {children}
        </a>
      );
    }
    return <span>{children}</span>;
  },
  img({ alt, src }) {
    return (
      <span className="text-muted-foreground">
        [image{alt ? `: ${alt}` : ""}, not loaded{typeof src === "string" && /^https?:/i.test(src) ? ` (${src})` : ""}]
      </span>
    );
  },
  table({ children }) {
    return (
      <div className="overflow-x-auto">
        <table>{children}</table>
      </div>
    );
  },
};

const REMARK: Options["remarkPlugins"] = [[remarkGfm, { singleTilde: false }], remarkMath, remarkRefs];
const REHYPE: Options["rehypePlugins"] = [[rehypeKatex, { throwOnError: false, strict: false, errorColor: "currentColor" }]];

export const Markdown = memo(function Markdown({ text, compact = false, className = "" }: { text: string; compact?: boolean; className?: string }) {
  const src = useMemo(() => normalizeMath(text ?? ""), [text]);
  return (
    <div className={`prose-s ${compact ? "compact" : ""} ${className}`}>
      <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={REHYPE} components={COMPONENTS}>
        {src}
      </ReactMarkdown>
    </div>
  );
});

/** Program text, output and logs: shown exactly as recorded. */
export function Code({ text, max = 60_000, className = "" }: { text: string; max?: number; className?: string }) {
  const cut = text.length > max;
  return (
    <pre className={`max-h-[28rem] overflow-auto rounded-sm border bg-secondary/60 p-3 font-mono text-[0.78rem] leading-relaxed ${className}`}>
      {cut ? `${text.slice(0, max)}\n… ${text.length - max} more characters not shown here` : text || "(empty)"}
    </pre>
  );
}
