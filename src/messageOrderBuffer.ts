// messageOrderBuffer.ts
// Guarantees chat rows are handed to the parser in strict data-index order.
//
// The parser's dedup (game.chatsProcessed) is a monotonic high-water mark, so
// processing row 244 before rows 68–243 locks the earlier rows out FOREVER —
// this is why dice/resource stats never caught up after a reconnect, where
// colonist's virtual scroller can render the bottom of the chat before the
// history sweep has covered the middle. This buffer captures rows in whatever
// order they render and only feeds the parser the contiguous prefix; rows
// after a gap wait until the gap fills (or until flush() gives up on it).
//
// Rows are captured as deep clones: virtual scrollers recycle DOM nodes, so a
// held reference may be rewritten to show a different message by the time the
// gap before it fills.

export class MessageOrderBuffer {
  private pending = new Map<number, HTMLElement>();
  private lastProcessed = -1;

  constructor(private processRow: (element: HTMLElement) => void) {}

  /**
   * Buffer one rendered chat row. Safe to call repeatedly with the same row
   * (dedups by data-index); rows at or below the high-water mark are ignored.
   */
  capture(element: HTMLElement): void {
    const dataIndexAttr = element.getAttribute('data-index');
    if (dataIndexAttr === null) return;
    const index = parseInt(dataIndexAttr, 10);
    if (isNaN(index) || index <= this.lastProcessed || this.pending.has(index))
      return;
    this.pending.set(index, element.cloneNode(true) as HTMLElement);
  }

  /**
   * Process the contiguous run of buffered rows starting right after the last
   * processed index. Stops at the first gap. Returns how many were processed.
   */
  drain(): number {
    let count = 0;
    while (this.pending.has(this.lastProcessed + 1)) {
      const element = this.pending.get(this.lastProcessed + 1)!;
      this.pending.delete(this.lastProcessed + 1);
      this.lastProcessed++;
      this.processRow(element);
      count++;
    }
    return count;
  }

  /**
   * Process everything still buffered in ascending order, accepting gaps.
   * Call once history loading has done its best — rows lost to a gap can't be
   * recovered, but everything captured after the gap still counts.
   */
  flush(): number {
    const indices = Array.from(this.pending.keys()).sort((a, b) => a - b);
    for (const index of indices) {
      const element = this.pending.get(index)!;
      this.pending.delete(index);
      this.lastProcessed = Math.max(this.lastProcessed, index);
      this.processRow(element);
    }
    return indices.length;
  }

  /** True when captured rows are stuck behind a gap (drain can't reach them). */
  hasPending(): boolean {
    return this.pending.size > 0;
  }
}
