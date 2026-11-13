// Small forgiving XML parser (no DOM available in tests or workers). Enough for SVG: prolog, comments, CDATA,
// DOCTYPE (incl. internal subset and simple <!ENTITY> declarations), self-closing tags, entities, namespaced names.

export interface XmlNode {
  /** Element name; the "svg:" prefix is stripped, other prefixes (e.g. "sodipodi:namedview") are kept. */
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Character data directly inside this element (CDATA included), entities decoded. */
  text: string;
}

const BASE_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Decode &amp; &lt; &gt; &quot; &apos;, numeric references and any extra named entities; unknown ones stay as written. */
export function decodeEntities(s: string, extra: Record<string, string> = {}): string {
  if (s.indexOf("&") < 0) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z_][\w.-]*);/g, (all, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return all;
      return String.fromCodePoint(code);
    }
    return BASE_ENTITIES[body] ?? extra[body] ?? all;
  });
}

const isSpace = (c: string | undefined) => c === " " || c === "\n" || c === "\t" || c === "\r";

/** Parse a document and return its first (root) element. Throws if there is none. */
export function parseXml(src: string): XmlNode {
  const n = src.length;
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  const doc: XmlNode = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [doc];
  const entities: Record<string, string> = {};

  const top = () => stack[stack.length - 1]!;

  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      top().text += decodeEntities(src.slice(i), entities);
      break;
    }
    if (lt > i) top().text += decodeEntities(src.slice(i, lt), entities);
    i = lt;

    if (src.startsWith("<!--", i)) {
      const e = src.indexOf("-->", i + 4);
      i = e < 0 ? n : e + 3;
    } else if (src.startsWith("<![CDATA[", i)) {
      const e = src.indexOf("]]>", i + 9);
      top().text += src.slice(i + 9, e < 0 ? n : e);
      i = e < 0 ? n : e + 3;
    } else if (src.startsWith("<?", i)) {
      const e = src.indexOf("?>", i + 2);
      i = e < 0 ? n : e + 2;
    } else if (src.startsWith("<!", i)) {
      // DOCTYPE: skip to the closing ">" outside quotes and the [ ... ] internal subset.
      let depth = 0;
      let quote = "";
      let j = i + 2;
      for (; j < n; j++) {
        const c = src[j]!;
        if (quote) {
          if (c === quote) quote = "";
        } else if (c === '"' || c === "'") quote = c;
        else if (c === "[") depth++;
        else if (c === "]") depth--;
        else if (c === ">" && depth <= 0) break;
      }
      const decl = src.slice(i, j);
      for (const m of decl.matchAll(/<!ENTITY\s+([\w.-]+)\s+(?:"([^"]*)"|'([^']*)')/g)) {
        entities[m[1]!] = decodeEntities(m[2] ?? m[3] ?? "");
      }
      i = j + 1;
    } else if (src[i + 1] === "/") {
      const e = src.indexOf(">", i);
      const name = normName(src.slice(i + 2, e < 0 ? n : e).trim());
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k]!.name === name) {
          stack.length = k;
          break;
        }
      }
      i = e < 0 ? n : e + 1;
    } else {
      // Start tag.
      let j = i + 1;
      while (j < n && !isSpace(src[j]) && src[j] !== "/" && src[j] !== ">") j++;
      const node: XmlNode = { name: normName(src.slice(i + 1, j)), attrs: {}, children: [], text: "" };
      let selfClose = false;
      while (j < n) {
        while (j < n && isSpace(src[j])) j++;
        const c = src[j];
        if (c === ">") {
          j++;
          break;
        }
        if (c === "/") {
          selfClose = src[j + 1] === ">";
          j += selfClose ? 2 : 1;
          if (selfClose) break;
          continue;
        }
        const ns = j;
        while (j < n && !isSpace(src[j]) && src[j] !== "=" && src[j] !== "/" && src[j] !== ">") j++;
        const an = src.slice(ns, j);
        while (j < n && isSpace(src[j])) j++;
        let value = "";
        if (src[j] === "=") {
          j++;
          while (j < n && isSpace(src[j])) j++;
          const q = src[j];
          if (q === '"' || q === "'") {
            const e = src.indexOf(q, j + 1);
            value = src.slice(j + 1, e < 0 ? n : e);
            j = e < 0 ? n : e + 1;
          } else {
            const vs = j;
            while (j < n && !isSpace(src[j]) && src[j] !== ">") j++;
            value = src.slice(vs, j);
          }
        }
        if (an) node.attrs[an] = decodeEntities(value, entities);
        else j++; // stray character; make progress
      }
      top().children.push(node);
      if (!selfClose) stack.push(node);
      i = j;
    }
  }

  const root = doc.children[0];
  if (!root) throw new Error("No XML element found");
  return root;
}

function normName(name: string): string {
  return name.startsWith("svg:") ? name.slice(4) : name;
}
