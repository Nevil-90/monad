/**
 * scripts/lib/report_source.js
 * Complete signed report sets for a feed at an exact time, fetched on demand from RedStone's gateway
 * history (fetchReportsAt: any 10 s report of the last 24 h). Nothing polls the gateway; the keeper
 * asks when a round needs a report, and the relay when someone requests one (SEC-28).
 * One history request returns every feed, so results are cached per timestamp and shared by all
 * markets. A timestamp whose reports are not complete yet is re-asked at most every RETRY_MS.
 */

import { fetchReportsAt } from '../../src/oracle.js';

// All signatures are in ~2 s after the timestamp; the gateway's CDN caches answers for 5 s
const PUBLISH_DELAY_MS = 1500;
const RETRY_MS = 1000;
const KEEP_MS = 30 * 60e3;

export class ReportSource {
  constructor({ feeds, signers, threshold, log = console }) {
    this.feeds = feeds;
    this.signers = signers;
    this.threshold = threshold;
    this.log = log;
    this.cache = new Map(); // tsMs -> { at, sets: { feed: reports[] } | null, pending: Promise | null }
    this.stats = { history: 0, historyErrors: 0 };
  }

  /** Complete report set (>= threshold signers) for `feed` at `tsSec`, or null if not available (yet) */
  async reportsAt(feed, tsSec) {
    const tsMs = Number(tsSec) * 1000;
    if (Date.now() < tsMs + PUBLISH_DELAY_MS) return null;
    const sets = await this.history(tsMs);
    const reports = sets?.[feed]?.map((p) => p.report) || [];
    if (reports.length < this.threshold) return null;
    this.stats.history++;
    return reports;
  }

  async history(tsMs) {
    this.prune();
    let entry = this.cache.get(tsMs);
    const complete = entry?.sets && this.feeds.every((f) => (entry.sets[f]?.length || 0) >= this.threshold);
    if (entry && (complete || entry.pending || Date.now() - entry.at < RETRY_MS)) return entry.pending ? entry.pending : entry.sets;
    const attempt = (entry?.attempt ?? -1) + 1;
    entry = { at: Date.now(), sets: entry?.sets || null, pending: null, attempt };
    this.cache.set(tsMs, entry);
    // The first ask may be served from the CDN cache; retries bypass it (the cached set was incomplete)
    entry.pending = fetchReportsAt(this.feeds, tsMs, { signers: this.signers, fresh: attempt === 0 ? null : attempt })
      .then((sets) => { entry.sets = sets; return sets; })
      .catch((err) => {
        this.stats.historyErrors++;
        this.log.error(`[history] ${tsMs / 1000}: ${err.message}`);
        return entry.sets;
      })
      .finally(() => { entry.pending = null; entry.at = Date.now(); });
    return entry.pending;
  }

  prune() {
    const cutoff = Date.now() - KEEP_MS;
    for (const ts of this.cache.keys()) if (ts < cutoff) this.cache.delete(ts);
  }

  /**
   * Earliest complete report set for `feed` in [firstSec, lastSec] on a `stepSec` grid, stopping at
   * `beforeSec` (exclusive) when given. Returns { ts, reports } or null.
   */
  async earliest(feed, firstSec, lastSec, stepSec, beforeSec = Infinity) {
    for (let ts = firstSec; ts <= lastSec && ts < beforeSec; ts += stepSec) {
      const reports = await this.reportsAt(feed, ts);
      if (reports) return { ts, reports };
    }
    return null;
  }
}
