/**
 * scripts/lib/report_archive.js
 * Captures signed RedStone reports as they are published and keeps them, because the free gateway
 * only serves the latest set (every 10 seconds) and not past ones. Used by the price relay and the
 * keeper. Only reports whose signature recovers to an authorised signer are kept.
 */

import { fetchLatestReports, medianUnits, fromUnits, REDSTONE_PRIMARY_SIGNERS } from '../../src/oracle.js';

export class ReportArchive {
  /**
   * @param {object} opts
   * @param {string[]} opts.feeds           e.g. ['BTC', 'ETH', 'SOL', 'MON']
   * @param {string[]} [opts.signers]       authorised signer addresses
   * @param {number} [opts.threshold]       signatures needed for a complete set (defaults to all signers)
   * @param {number} [opts.keepMs]          how long to keep full signed reports
   * @param {number} [opts.seriesKeepMs]    how long to keep median prices (chart history)
   * @param {number} [opts.pollMs]          gateway poll interval
   * @param {(feed, tsMs, price) => void} [opts.onComplete] called once per feed and timestamp when complete
   */
  constructor({ feeds, signers = REDSTONE_PRIMARY_SIGNERS, threshold = signers.length, keepMs = 2 * 3600e3, seriesKeepMs = keepMs, pollMs = 2000, onComplete, log = console }) {
    this.feeds = feeds;
    this.signers = signers;
    this.threshold = threshold;
    this.keepMs = keepMs;
    this.seriesKeepMs = seriesKeepMs;
    this.medians = new Map(feeds.map((f) => [f, new Map()])); // feed -> tsMs -> median price
    this.pollMs = pollMs;
    this.onComplete = onComplete;
    this.log = log;
    this.byFeed = new Map(feeds.map((f) => [f, new Map()])); // feed -> tsMs -> Map(signer -> report)
    this.completed = new Set();                             // `${feed}:${tsMs}`
    this.status = { ok: false, lastPoll: 0, error: null };
  }

  start() {
    const tick = async () => {
      try {
        await this.poll();
        this.status = { ok: true, lastPoll: Date.now(), error: null };
      } catch (err) {
        this.status = { ...this.status, ok: false, error: err.message };
        this.log.error(`[archive] ${err.message}`);
      }
      this.timer = setTimeout(tick, this.pollMs);
    };
    tick();
  }

  stop() {
    clearTimeout(this.timer);
  }

  async poll() {
    const latest = await fetchLatestReports(this.feeds, { signers: this.signers });
    const cutoff = Date.now() - this.keepMs;
    for (const feed of this.feeds) {
      const sets = this.byFeed.get(feed);
      for (const { signer, report } of latest[feed]) {
        const ts = Number(report.timestampMs);
        if (!sets.has(ts)) sets.set(ts, new Map());
        sets.get(ts).set(signer.toLowerCase(), report);
      }
      for (const [ts, set] of sets) {
        if (ts < cutoff) {
          sets.delete(ts);
          this.completed.delete(`${feed}:${ts}`);
          continue;
        }
        const key = `${feed}:${ts}`;
        if (set.size >= this.threshold && !this.completed.has(key)) {
          this.completed.add(key);
          const price = fromUnits(medianUnits([...set.values()].map((r) => r.value)));
          this.medians.get(feed).set(ts, price);
          if (this.onComplete) this.onComplete(feed, ts, price);
        }
      }
      const seriesCutoff = Date.now() - this.seriesKeepMs;
      for (const ts of this.medians.get(feed).keys()) if (ts < seriesCutoff) this.medians.get(feed).delete(ts);
    }
  }

  /** Complete report set for a feed at a timestamp in seconds, or null if it was not captured */
  reportsAt(feed, tsSec) {
    const set = this.byFeed.get(feed)?.get(Number(tsSec) * 1000);
    if (!set || set.size < this.threshold) return null;
    return [...set.values()];
  }

  /** Median price series of complete sets: [[tsMs, price], ...], oldest first */
  series(feed) {
    return [...(this.medians.get(feed) || [])].sort((a, b) => a[0] - b[0]);
  }
}
