import React, { useRef, useState } from "react";
import "../styles/codeblock.css";

type Props = {
  code: string;
  label?: string;          // visible label above the code (optional)
  language?: string;       // e.g. "bash", "powershell" (for styling only)
  className?: string;
  /** If set to "bash", the copied text unescapes \$ -> $ so it's runnable in a shell */
  runnableFor?: "bash" | null;
};

function unescapeForBash(s: string) {
  // turn \${...}, \$(...), \$? etc. into ${...}, $(...), $?
  return s.replace(/\\\$/g, "$");
}

const CopyCode: React.FC<Props> = ({ code, label, language, className, runnableFor = null }) => {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  // Prepare code for copying (display stays escaped; clipboard gets runnable bash when requested)
  const prepared = runnableFor === "bash" ? unescapeForBash(code) : code;

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(prepared);
      } else {
        // Fallback for older browsers / http contexts
        const ta = document.createElement("textarea");
        ta.value = prepared;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
      timeoutRef.current = window.setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.error("Clipboard failed", e);
    }
  };

  return (
    <figure className={`codeblock ${className ?? ""}`} data-language={language ?? ""}>
      <figcaption className="codeblock__cap">
        <span>{label ?? "Kód"}</span>
        <button
          type="button"
          className={`codeblock__copy ${copied ? "is-copied" : ""}`}
          onClick={copy}
          aria-live="polite"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </figcaption>
      <pre className="codeblock__pre"><code>{code}</code></pre>
    </figure>
  );
};

export default CopyCode;
