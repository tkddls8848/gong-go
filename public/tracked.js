(function (scope) {
  "use strict";
  const STORAGE_KEY = "gong-go:tracked-businesses";
  const TYPES = new Set(["", "물품", "외자", "용역", "공사"]);
  const STATES = new Set(["before", "opened", "failed", "rebid", "other"]);
  const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const text = value => typeof value === "string" ? value : "";
  const identifier = value => typeof value === "string" && value.length > 0 && value.length <= 200;
  const clone = value => JSON.parse(JSON.stringify(value));
  const finite = value => typeof value === "number" && Number.isFinite(value);
  const safeError = code => ({ code: code === "not_authorized" ? code : "upstream", message: code === "not_authorized"
    ? "낙찰·계약과정 조회 권한이 없습니다. 서비스 키의 활용신청을 확인하세요."
    : "공고 진행 정보를 확인하지 못했습니다. 잠시 뒤 다시 확인하세요." });
  function failure(code) {
    const info = code === "storage" ? { code, message: "관심사업을 저장하지 못했습니다. 브라우저 저장 공간과 설정을 확인하세요." } : safeError(code);
    return Object.assign(new Error(info.message), { code: info.code });
  }
  function chain(value) {
    if (value === null) return null;
    if (!record(value) || !["spec", "plan"].includes(value.kind) || !identifier(value.no)) throw failure();
    return { kind: value.kind, no: value.no };
  }
  function numeric(value) {
    if (value === undefined || value === null) return null;
    if (!finite(value)) throw failure();
    return value;
  }
  function strings(value, keys) {
    const out = {};
    for (const key of keys) {
      if (value[key] !== undefined && typeof value[key] !== "string") throw failure();
      out[key] = value[key] || "";
    }
    return out;
  }
  function bidder(value, winner = false) {
    if (!record(value) || typeof value.name !== "string") throw failure();
    const out = strings(value, winner ? ["name", "bizno"] : ["name", "bizno", "remark"]);
    for (const key of winner ? ["rank", "amount", "rate"] : ["rank", "amount", "rate", "techScore", "priceScore", "totalScore"]) out[key] = numeric(value[key]);
    return out;
  }
  function notice(value, current = false) {
    if (!record(value) || !identifier(value.bidNtceNo) || !STATES.has(value.state)) throw failure();
    const out = { ...strings(value, ["bidNtceNo", "ord", "title", "postedAt", "method", "bidMethod", "stateLabel", "openedAt", "reason"]), state: value.state };
    if (value.winners !== undefined && !Array.isArray(value.winners)) throw failure();
    out.winners = (value.winners || []).map(item => bidder(item, true));
    if (current) {
      if (value.bidders !== undefined && !Array.isArray(value.bidders)) throw failure();
      if (value.biddersTruncated !== undefined && typeof value.biddersTruncated !== "boolean") throw failure();
      out.participants = numeric(value.participants);
      out.notice = strings(value, ["notice"]).notice;
      out.bidders = (value.bidders || []).map(item => bidder(item));
      out.biddersTruncated = value.biddersTruncated || false;
    }
    return out;
  }
  function result(value) {
    if (!record(value) || !["spec", "bid"].includes(value.stage) || !TYPES.has(value.businessType) || !Array.isArray(value.notices) || !["", "chain", "limit"].includes(value.partial)) throw failure();
    const out = { stage: value.stage, businessType: value.businessType, chainKey: chain(value.chainKey), notices: value.notices.map(item => notice(item)), current: value.current === null ? null : notice(value.current, true), partial: value.partial };
    if (out.stage === "spec") {
      if (out.current || out.notices.length || out.chainKey?.kind !== "spec") throw failure();
    } else if (!out.current || !out.notices.length || out.notices.at(-1).bidNtceNo !== out.current.bidNtceNo) throw failure();
    return out;
  }
  function schedule(value) {
    if (!record(value)) return {};
    return Object.fromEntries(["bidClseDt", "opengDt", "opninRgstClseDt"].filter(key => typeof value[key] === "string").map(key => [key, value[key]]));
  }
  function parseTime(value) {
    if (typeof value !== "string" || !value) return NaN;
    const local = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(?::(\d{2}))?)?$/.exec(value);
    if (local) {
      const wallTime = `${local[1]}T${local[2] || "00:00"}:${local[3] || "00"}`;
      const parsed = Date.parse(`${wallTime}+09:00`);
      return Number.isFinite(parsed) && new Date(parsed + 9 * 3600000).toISOString().slice(0, 19) === wallTime ? parsed : NaN;
    }
    return /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
  }
  function sameChain(a, b) { return !!a && !!b && a.kind === b.kind && a.no === b.no; }
  function sameBusiness(a, b) {
    return a.id === b.id || sameChain(a.chainKey, b.chainKey)
      || (a.savedFrom === "bid" && b.result?.notices.some(item => item.bidNtceNo === a.savedNo))
      || (b.savedFrom === "bid" && a.result?.notices.some(item => item.bidNtceNo === b.savedNo));
  }
  function loadedItem(value) {
    if (!record(value) || !["bid", "pre"].includes(value.savedFrom) || !identifier(value.savedNo) || value.id !== `${value.savedFrom}:${value.savedNo}` || typeof value.title !== "string" || typeof value.institution !== "string" || !finite(value.savedAt)) return null;
    let key;
    try { key = chain(value.chainKey); } catch { return null; }
    let last = null;
    try { if (value.result !== null) last = result(value.result); } catch { /* Invalid cached results must be fetched again. */ }
    return {
      id: value.id, savedFrom: value.savedFrom, savedNo: value.savedNo, title: value.title,
      institution: value.institution, detailUrl: text(value.detailUrl), businessType: TYPES.has(value.businessType) ? value.businessType : "",
      chainKey: value.savedFrom === "pre" ? { kind: "spec", no: value.savedNo } : key,
      schedule: schedule(value.schedule), savedAt: value.savedAt, result: last,
      checkedAt: last && finite(value.checkedAt) ? value.checkedAt : null,
      error: record(value.error) ? safeError(value.error.code) : null,
    };
  }
  function createTracked({ storage, fetchJson, now = () => Date.now(), html, concurrency = 3 } = {}) {
    let unavailable = false, list = [], running = null;
    const generations = new Map();
    try {
      if (storage === undefined) storage = scope.localStorage;
      if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") unavailable = true;
      else {
        const raw = storage.getItem(STORAGE_KEY);
        let saved;
        try { saved = JSON.parse(raw); } catch { saved = null; }
        if (saved?.version === 1 && Array.isArray(saved.items)) {
          for (const value of saved.items) {
            const item = loadedItem(value);
            if (item && !list.some(existing => sameBusiness(existing, item))) list.push(item);
          }
        }
      }
    } catch { unavailable = true; }
    list.forEach(item => generations.set(item.id, Symbol()));
    const limit = Number.isInteger(concurrency) && concurrency > 0 ? Math.min(concurrency, 3) : 3;
    function commit(next) {
      if (unavailable) throw failure("storage");
      try { storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, items: next })); }
      catch { throw failure("storage"); }
      list = next;
      for (const id of generations.keys()) if (!list.some(item => item.id === id)) generations.delete(id);
    }
    function matching(row) {
      if (!row || !["bid", "pre"].includes(row.mode) || !identifier(row.announcementNumber)) return null;
      return list.find(item => item.id === `${row.mode}:${row.announcementNumber}`
        || (row.mode === "pre" && item.chainKey?.kind === "spec" && item.chainKey.no === row.announcementNumber)
        || (row.mode === "bid" && item.result?.notices.some(notice => notice.bidNtceNo === row.announcementNumber))) || null;
    }
    function remove(id) {
      if (list.some(item => item.id === id)) commit(list.filter(item => item.id !== id));
    }
    function toggle(row) {
      if (!row || !["bid", "pre"].includes(row.mode) || !identifier(row.announcementNumber)) return { saved: false, item: null };
      const existing = matching(row);
      if (existing) { remove(existing.id); return { saved: false, item: null }; }
      const item = {
        id: `${row.mode}:${row.announcementNumber}`, savedFrom: row.mode, savedNo: row.announcementNumber,
        title: text(row.title), institution: text(row.institution), detailUrl: text(row.detailUrl),
        businessType: row.mode === "pre" && TYPES.has(row.businessType) ? row.businessType : "",
        chainKey: row.mode === "pre" ? { kind: "spec", no: row.announcementNumber } : null,
        schedule: row.mode === "pre" ? { opninRgstClseDt: text(row.closeAt) } : schedule(row.bidSchedule || { bidClseDt: text(row.closeAt) }),
        savedAt: now(), result: null, checkedAt: null, error: null,
      };
      commit([...list, item]); generations.set(item.id, Symbol());
      return { saved: true, item: clone(item) };
    }
    function dueItems(nowMs = now()) {
      return clone(list.filter(item => {
        if (!item.result || item.checkedAt === null || item.error || item.result.partial || item.result.stage === "spec") return true;
        const current = item.result.current;
        if (current.state === "opened") return false;
        if (current.state !== "before" || current.bidNtceNo !== item.savedNo) return true;
        const reference = parseTime(item.schedule.opengDt || item.schedule.bidClseDt);
        return !Number.isFinite(reference) || reference <= nowMs;
      }));
    }
    function applyResult(id, body, receivedAt = now()) {
      const index = list.findIndex(item => item.id === id);
      if (index < 0) return;
      if (!finite(receivedAt)) throw failure();
      if (list[index].checkedAt !== null && receivedAt < list[index].checkedAt) return;
      const checked = result(body), next = clone(list);
      const updated = { ...next[index], result: checked, checkedAt: receivedAt, error: null };
      if (checked.businessType) updated.businessType = checked.businessType;
      if (checked.chainKey) updated.chainKey = checked.chainKey;
      next[index] = updated;
      // Keep the earliest saved snapshot when two previously separate entries are linked.
      const duplicates = next.filter(item => sameBusiness(item, updated));
      const survivor = duplicates[0];
      let replacedSurvivor = false;
      if (survivor.id !== updated.id && (survivor.checkedAt === null || receivedAt >= survivor.checkedAt)) {
        survivor.result = checked; survivor.checkedAt = receivedAt; survivor.error = null;
        survivor.businessType = updated.businessType; survivor.chainKey = updated.chainKey;
        replacedSurvivor = true;
      }
      const duplicateIds = new Set(duplicates.slice(1).map(item => item.id));
      commit(next.filter(item => !duplicateIds.has(item.id)));
      // A pending request for the survivor used its old snapshot. Once another saved
      // notice supplies its result, neither that old response nor its error may replace it.
      if (replacedSurvivor) generations.set(survivor.id, Symbol());
    }
    function applyError(id, error) {
      if (!list.some(item => item.id === id)) return;
      commit(list.map(item => item.id === id ? { ...item, error: safeError(error?.code) } : item));
    }
    function refresh({ all = false } = {}) {
      if (running) return running;
      const pending = (all ? clone(list) : dueItems()).map(item => ({ item, generation: generations.get(item.id) }));
      let cursor = 0;
      async function worker() {
        while (cursor < pending.length) {
          const { item, generation } = pending[cursor++];
          const current = () => generations.get(item.id) === generation;
          if (!current()) continue;
          const params = new URLSearchParams();
          if (item.savedFrom === "bid") params.set("bidNtceNo", item.savedNo);
          if (item.chainKey) params.set(item.chainKey.kind === "spec" ? "specNo" : "planNo", item.chainKey.no);
          if (item.businessType) params.set("businessType", item.businessType);
          try {
            const body = await fetchJson(`/api/business-status?${params}`);
            if (current()) applyResult(item.id, body, now());
          } catch (error) {
            if (!current()) continue;
            if (error?.code === "storage") throw error;
            applyError(item.id, error);
          }
        }
      }
      // Keep the shared run alive until every request settles, including when persistence fails.
      running = Promise.resolve().then(() => Promise.allSettled(Array.from({ length: Math.min(limit, pending.length) }, worker))).then(outcomes => {
        const rejected = outcomes.find(outcome => outcome.status === "rejected");
        if (rejected) throw rejected.reason;
      }).finally(() => { running = null; });
      return running;
    }
    return { items: () => clone(list), count: () => list.length, isSaved: row => !!matching(row), toggle, remove, dueItems, applyResult, applyError, refresh };
  }
  const api = { createTracked };
  scope.GongTracked = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self === "undefined" ? globalThis : self);
