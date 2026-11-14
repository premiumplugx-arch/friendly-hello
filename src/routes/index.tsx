import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Premium Plugx Proxy — Stream Link Builder" },
      {
        name: "description",
        content:
          "Build a CORS-free proxy link for any HLS, DASH or direct stream, with cookie, referer and user-agent support.",
      },
      { property: "og:title", content: "Premium Plugx Proxy — Stream Link Builder" },
      {
        property: "og:description",
        content:
          "Build a CORS-free proxy link for any HLS, DASH or direct stream, with cookie, referer and user-agent support.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

type Field = { key: string; label: string; placeholder: string };

const OPTIONAL_FIELDS: Field[] = [
  { key: "cookie", label: "Cookie", placeholder: "hdntl=...; sid=..." },
  { key: "ref", label: "Referer", placeholder: "https://www.sonyliv.com/" },
  { key: "ua", label: "User agent", placeholder: "leave empty for auto" },
  { key: "origin", label: "Origin", placeholder: "https://www.sonyliv.com" },
];

function Index() {
  const [url, setUrl] = useState("");
  const [extras, setExtras] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);

  const proxied = useMemo(() => {
    if (!url.trim()) return "";
    const base =
      (typeof window === "undefined" ? "" : window.location.origin) + "/api/public/proxy";
    const params = new URLSearchParams({ u: url.trim() });
    for (const f of OPTIONAL_FIELDS) {
      const v = extras[f.key]?.trim();
      if (v) params.set(f.key, v);
    }
    return `${base}?${params.toString()}`;
  }, [url, extras]);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[420px]"
        style={{ backgroundImage: "var(--grid-glow)" }}
      />
      <div className="relative mx-auto w-full max-w-3xl px-5 py-16">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-primary">
          premium plugx
        </p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">
          Ultra proxy
        </h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
          Paste a stream or file URL, get a clean proxied link. Open it in your browser and
          it plays with the built-in player — HLS playlists, DASH manifests, subtitles and
          byte ranges are all handled server-side.
        </p>

        <div className="mt-10 rounded-xl border border-border bg-card p-5 shadow-lg">
          <label className="block font-mono text-xs uppercase tracking-widest text-muted-foreground">
            Stream URL
          </label>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            spellCheck={false}
            placeholder="https://dishmt.slivcdn.com/.../master.m3u8"
            className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2.5 font-mono text-sm text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-ring focus:ring-1 focus:ring-ring"
          />

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {OPTIONAL_FIELDS.map((f) => (
              <div key={f.key}>
                <label className="block font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                  {f.label}
                </label>
                <input
                  value={extras[f.key] ?? ""}
                  onChange={(e) => setExtras((s) => ({ ...s, [f.key]: e.target.value }))}
                  spellCheck={false}
                  placeholder={f.placeholder}
                  className="mt-1.5 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-ring focus:ring-1 focus:ring-ring"
                />
              </div>
            ))}
          </div>

          <div className="mt-5 rounded-md border border-border bg-secondary/40 p-3">
            <p className="break-all font-mono text-xs text-primary">
              {proxied || "Your proxy link appears here."}
            </p>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <a
              href={proxied || "#"}
              target="_blank"
              rel="noreferrer"
              aria-disabled={!proxied}
              className={`inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 ${
                proxied ? "" : "pointer-events-none opacity-40"
              }`}
            >
              Open in browser
            </a>
            <button
              type="button"
              disabled={!proxied}
              onClick={() => {
                void navigator.clipboard.writeText(proxied);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="inline-flex items-center rounded-md border border-border bg-secondary px-4 py-2 text-sm font-medium text-secondary-foreground transition-colors hover:bg-muted disabled:opacity-40"
            >
              {copied ? "Copied" : "Copy link"}
            </button>
            <a
              href={proxied ? proxied + "&debug=1" : "#"}
              target="_blank"
              rel="noreferrer"
              className={`inline-flex items-center rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted ${
                proxied ? "" : "pointer-events-none opacity-40"
              }`}
            >
              Diagnose
            </a>
          </div>
        </div>

        <div className="mt-8 grid gap-3 sm:grid-cols-2">
          {[
            ["Any format", "HLS, DASH, MP4, keys, subtitles and byte-range seeking."],
            ["Signed CDNs", "Tokens, cookies and referers ride along on every segment."],
            ["Auto identity", "SonyLiv, Hotstar and JioCinema headers applied automatically."],
            ["Resilient", "Redirect chasing, timeouts and automatic retries built in."],
          ].map(([title, body]) => (
            <div key={title} className="rounded-lg border border-border bg-card/60 p-4">
              <h2 className="text-sm font-semibold text-foreground">{title}</h2>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{body}</p>
            </div>
          ))}
        </div>

        <p className="mt-8 font-mono text-[11px] leading-relaxed text-muted-foreground">
          Endpoint: /api/public/proxy?u=&lt;url&gt; · extras: cookie, ref, ua, origin,
          h.&lt;header&gt;, mode=hls|dash|vtt|html, timeout, retries, debug=1
        </p>
      </div>
    </main>
  );
}
