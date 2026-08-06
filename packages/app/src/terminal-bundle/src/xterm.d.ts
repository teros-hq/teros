// Type declarations for xterm.js modules (bundled via CDN in the iframe, not installed in node_modules)
declare module '@xterm/xterm' {
  export class Terminal {
    constructor(options?: any);
    cols: number;
    rows: number;
    open(element: HTMLElement): void;
    write(data: string | Uint8Array): void;
    clear(): void;
    onData(handler: (data: string) => void): void;
    loadAddon(addon: any): void;
    dispose(): void;
  }
}

declare module '@xterm/addon-fit' {
  export class FitAddon {
    fit(): void;
  }
}

declare module '@xterm/addon-web-links' {
  export class WebLinksAddon {
    constructor();
  }
}
