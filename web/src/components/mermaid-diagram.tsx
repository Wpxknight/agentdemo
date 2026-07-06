import { useEffect, useState } from 'react';
import type MermaidApi from 'mermaid';

type Mermaid = typeof MermaidApi;

/** mermaid 体积很大（>1MB），首次遇到 mermaid 代码块时才动态加载。 */
let mermaidPromise: Promise<Mermaid> | null = null;

function loadMermaid(): Promise<Mermaid> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((mod) => {
      const mermaid = mod.default;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'neutral',
        fontFamily:
          'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif',
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

let renderSeq = 0;

function MermaidZoomOverlay({ svg, onClose }: { svg: string; onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="mermaid-overlay" role="dialog" aria-label="图表放大预览" onClick={onClose}>
      <div className="mermaid-overlay-canvas" dangerouslySetInnerHTML={{ __html: svg }} />
      <div className="mermaid-overlay-hint">点击任意位置或按 Esc 关闭</div>
    </div>
  );
}

/**
 * 渲染 mermaid 代码块为 SVG，点击可全屏放大。流式输出期间代码往往不完整、parse 会失败：
 * 保留上一次成功的 SVG（渐进渲染），从未成功过则回退为普通代码块展示源码。
 */
export function MermaidDiagram({ code }: { code: string }) {
  const [svg, setSvg] = useState('');
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadMermaid()
      .then(async (mermaid) => {
        await mermaid.parse(code);
        const { svg: rendered } = await mermaid.render(`mermaid-diagram-${++renderSeq}`, code);
        if (!cancelled) setSvg(rendered);
      })
      .catch(() => {
        /* 代码不完整或语法错误：保持现状 */
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (!svg) {
    return (
      <div className="markdown-code-frame">
        <div className="markdown-code-language">mermaid</div>
        <pre className="markdown-code-block">
          <code className="markdown-code">{code}</code>
        </pre>
      </div>
    );
  }

  return (
    <>
      <div
        className="markdown-mermaid"
        role="button"
        tabIndex={0}
        title="点击放大"
        onClick={() => setZoomed(true)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setZoomed(true);
          }
        }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      {zoomed ? <MermaidZoomOverlay svg={svg} onClose={() => setZoomed(false)} /> : null}
    </>
  );
}
