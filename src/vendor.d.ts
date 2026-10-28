declare module 'gifenc' {
  export function GIFEncoder(): {
    writeFrame(indices: Uint8Array, width: number, height: number, options: { palette: number[][]; delay?: number; repeat?: number; dispose?: number; transparent?: boolean; transparentIndex?: number }): void;
    finish(): void;
    bytesView(): Uint8Array;
  };
  export function quantize(rgba: Uint8Array | Uint8ClampedArray, colors: number, options?: { format?: 'rgba4444' | 'rgb565'; oneBitAlpha?: boolean }): number[][];
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: number[][], format?: 'rgba4444' | 'rgb565'): Uint8Array;
}
