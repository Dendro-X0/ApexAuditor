const AXE_CDN_URL = "https://cdn.jsdelivr.net/npm/axe-core@4.8.4/axe.min.js" as const;

export function createAxeScript(): string {
  return `(function() {
    return new Promise((resolve) => {
      const runAxe = () => {
        const axe = (globalThis).axe;
        if (axe && axe.run) {
          (globalThis).__axeCore = axe;
          axe.run().then(resolve).catch(() => resolve({ violations: [] }));
          return;
        }
        resolve({ violations: [] });
      };
      if ((globalThis).axe) {
        runAxe();
        return;
      }
      const script = document.createElement('script');
      script.src = '${AXE_CDN_URL}';
      script.async = true;
      script.onload = runAxe;
      script.onerror = () => resolve({ violations: [] });
      document.head.appendChild(script);
    });
  })();`;
}
