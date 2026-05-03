/* global Papa, Plotly */
"use strict";

(function (global) {
  const MANIFEST_URL = "data-manifest.json";
  const EXPECTED_TRIALS = 80;
  /** 題目最長等待秒數；未按鍵逾時列視為錯誤並以此毫秒計 RT */
  const NO_RESPONSE_RT_MS = 5000;

  /** 圖表與聚合用的實驗組別順序（對應下方 trialAbGroup） */
  const AB_GROUP_ORDER = ["A", "B", "C", "D", "E", "F"];
  const AB_GROUP_OTHER = "（其他）";

  /** A–F 組別之完整定義（圖表 hover 與說明文字共用語意） */
  const AB_GROUP_DESC = {
    A: "台華共同詞；華語詞頻懸、台語詞頻懸。",
    B: "台華共同詞；華語詞頻懸、台語詞頻低。",
    C: "台華共同詞；華語詞頻低、台語詞頻懸。",
    D: "台華共同詞；華語詞頻低、台語詞頻低。",
    E: "純台語詞；皆為教育部 700 推薦字詞範圍內之詞彙。",
    F: "假詞。",
  };

  function abGroupDefinitionText(lab) {
    if (AB_GROUP_DESC[lab]) return AB_GROUP_DESC[lab];
    return "無法依 A–F 規則歸類之試次（如缺欄或欄位組合與 CSV 分組異常）。";
  }

  /** 圖表用等級順序：CEFR A1–C2、未考取；無法對應之原始填答暫歸「（待標準化）」並於品質區塊列出。 */
  const CERT_ORDER = ["未考取", "A1", "A2", "B1", "B2", "C1", "C2", "（待標準化）"];

  const plotlyLayoutBase = {
    font: { family: '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif', size: 12 },
    margin: { t: 36, r: 20, b: 48, l: 52 },
    paper_bgcolor: "#fff",
    plot_bgcolor: "#f7f9fc",
    colorway: ["#2980b9", "#1e8449", "#d68910", "#c0392b"],
  };

  function trimStr(v) {
    if (v === undefined || v === null) return "";
    return String(v).trim();
  }

  function normalizeGender(raw) {
    const t = trimStr(raw).toLowerCase();
    if (!t) return "未知";
    if (/^(男|m|male)$/i.test(t)) return "男";
    if (/^(女|f|female)$/i.test(t)) return "女";
    return "其他";
  }

  /**
   * 將「台語檢定成績」欄位標準化為 CEFR A1–C2 或「未考取」。
   * @returns {{ level: string, unmappedRaw: string | null }} unmappedRaw 僅在歸入「（待標準化）」時為原始字串，供品質說明列出。
   */
  function normalizeCert(raw) {
    const t0 = trimStr(raw);
    if (!t0 || t0 === "0") return { level: "未考取", unmappedRaw: null };

    const compact = t0.replace(/\s+/g, "");
    const lat = compact.toUpperCase();
    if (/^(A1|A2|B1|B2|C1|C2)$/.test(lat)) return { level: lat, unmappedRaw: null };

    if (/^(無|沒有|沒考|未考|未考取|無檢定|N\/A|NA|NONE)$/i.test(t0)) {
      return { level: "未考取", unmappedRaw: null };
    }

    if (/教育部B卷205/i.test(t0)) return { level: "B1", unmappedRaw: null };
    if (t0 === "教育部B1" || /^教育部\s*B1$/i.test(t0)) return { level: "B1", unmappedRaw: null };

    if (t0 === "高級") return { level: "C1", unmappedRaw: null };
    if (t0 === "422") return { level: "C1", unmappedRaw: null };

    if (/^[Bb]$/.test(t0)) return { level: "B1", unmappedRaw: null };

    return { level: "（待標準化）", unmappedRaw: t0 };
  }

  function certSortKey(label) {
    const i = CERT_ORDER.indexOf(label);
    return i >= 0 ? i : 999;
  }

  function parseNum(v) {
    if (v === undefined || v === null || v === "") return NaN;
    const n = Number(String(v).trim());
    return Number.isFinite(n) ? n : NaN;
  }

  function parseCorr(v) {
    const n = parseNum(v);
    if (n === 1) return 1;
    if (n === 0) return 0;
    return NaN;
  }

  function rowIsComplete(rows) {
    return rows.some((r) => trimStr(r["thanksroutine.started"]) !== "");
  }

  function getDemoRow(rows) {
    for (let i = 0; i < rows.length; i++) {
      if (trimStr(rows[i].participant)) return rows[i];
    }
    return null;
  }

  function trialLoopRanIsOne(val) {
    if (val === 1 || val === true) return true;
    return trimStr(val) === "1";
  }

  function getRawFormalTrialRows(rows) {
    return rows.filter((r) => {
      if (!trialLoopRanIsOne(r["trialloop.ran"])) return false;
      if (!trimStr(r["trialroutine.started"])) return false;
      return true;
    });
  }

  function hasKeyboardResponse(row) {
    return trimStr(row["trialkeyboard.keys"]) !== "";
  }

  function trialRtSeconds(row) {
    const rt = parseNum(row["trialkeyboard.rt"]);
    if (Number.isFinite(rt) && rt >= 0) return rt;
    const start = parseNum(row["trialroutine.started"]);
    const stop = parseNum(row["trialroutine.stopped"]);
    if (Number.isFinite(start) && Number.isFinite(stop) && stop >= start) {
      return stop - start;
    }
    return NaN;
  }

  function rowToTrialObject(r, participant, fileName) {
    const responded = hasKeyboardResponse(r);
    let rtMs;
    let corr;
    if (!responded) {
      rtMs = NO_RESPONSE_RT_MS;
      corr = 0;
    } else {
      const rtSec = trialRtSeconds(r);
      if (Number.isFinite(rtSec) && rtSec >= 0) {
        rtMs = rtSec * 1000;
      } else {
        const start = parseNum(r["trialroutine.started"]);
        const stop = parseNum(r["trialroutine.stopped"]);
        if (Number.isFinite(start) && Number.isFinite(stop) && stop >= start) {
          rtMs = (stop - start) * 1000;
        } else {
          rtMs = NO_RESPONSE_RT_MS;
        }
      }
      corr = parseCorr(r["trialkeyboard.corr"]);
      if (!Number.isFinite(corr)) corr = 0;
    }
    const o = {
      participant,
      fileName,
      rtMs,
      corr,
      key: itemKey(r),
      漢字: trimStr(r["漢字"]),
      臺羅: trimStr(r["臺羅"]) || trimStr(r["台羅"]),
      分組: trimStr(r["分組"]),
      isword: trimStr(r.isword),
      台語詞頻分組: trimStr(r["台語詞頻分組"]),
      華語詞頻分組: trimStr(r["華語詞頻分組"]),
      ifile: trimStr(r.ifile),
      thisIndex: trimStr(r["trialloop.thisIndex"]),
      imputed: false,
    };
    o.ab組 = trialAbGroup(o);
    return o;
  }

  function imputedMissingTrial(thisN, participant, fileName) {
    return {
      participant,
      fileName,
      rtMs: NO_RESPONSE_RT_MS,
      corr: 0,
      key: "__csv_missing_thisN__:" + thisN,
      漢字: "（CSV 缺此試次列）",
      臺羅: "",
      分組: "（資料缺列）",
      isword: "",
      台語詞頻分組: "",
      華語詞頻分組: "",
      ifile: "",
      thisIndex: String(thisN),
      imputed: true,
      ab組: AB_GROUP_OTHER,
    };
  }

  function buildEightyTrialsFromRows(rawRows, participant, fileName, quality) {
    const byN = new Map();
    for (let i = 0; i < rawRows.length; i++) {
      const r = rawRows[i];
      const n = parseNum(r["trialloop.thisN"]);
      if (!Number.isFinite(n) || n < 0 || n >= EXPECTED_TRIALS) {
        quality.push("略過 trialloop.thisN 無效之一列");
        continue;
      }
      byN.set(n, r);
    }

    const trials = [];
    for (let n = 0; n < EXPECTED_TRIALS; n++) {
      if (byN.has(n)) {
        trials.push(rowToTrialObject(byN.get(n), participant, fileName));
      } else {
        quality.push("缺 trialloop.thisN=" + n + " 列，已以 " + NO_RESPONSE_RT_MS + "ms、錯誤補齊");
        trials.push(imputedMissingTrial(n, participant, fileName));
      }
    }
    return trials;
  }

  function itemKey(row) {
    const f = trimStr(row.ifile);
    if (f) return "ifile:" + f;
    const han = trimStr(row["漢字"]);
    const grp = trimStr(row["分組"]);
    const iw = trimStr(row.isword);
    return "han:" + han + "|" + grp + "|" + iw;
  }

  /**
   * 將 CSV 之分組與詞頻欄位對應為本實驗之 A–F 組別。
   * A–D：台華共同詞（實驗材料）× 華／台詞頻懸低；E：純台語詞；F：假詞。
   */
  function trialAbGroup(t) {
    const grp = trimStr(t.分組);
    const tw = trimStr(t.台語詞頻分組);
    const hua = trimStr(t.華語詞頻分組);
    if (/filler_假詞/.test(grp) || (grp.includes("假詞") && !grp.includes("純台語"))) return "F";
    if (/filler_純台語/.test(grp) || grp.includes("純台語")) return "E";
    if (grp === "實驗材料" || grp.includes("共同")) {
      if (hua === "懸" && tw === "懸") return "A";
      if (hua === "懸" && tw === "低") return "B";
      if (hua === "低" && tw === "懸") return "C";
      if (hua === "低" && tw === "低") return "D";
    }
    return AB_GROUP_OTHER;
  }

  function mean(arr) {
    if (!arr.length) return NaN;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  function sdSample(arr) {
    if (arr.length < 2) return NaN;
    const m = mean(arr);
    const v = arr.reduce((s, x) => s + (x - m) * (x - m), 0) / (arr.length - 1);
    return Math.sqrt(v);
  }

  function processOneFile(text, sourcePath) {
    const name = sourcePath.split("/").pop() || sourcePath;
    const out = {
      fileName: name,
      sourcePath,
      ok: false,
      error: null,
      complete: false,
      participant: "",
      demo: null,
      formalCount: 0,
      trials: [],
      quality: [],
    };

    if (!trimStr(text)) {
      out.error = "檔案空白";
      out.quality.push("空白檔案");
      return out;
    }

    let parsed;
    try {
      parsed = Papa.parse(text, { header: true, skipEmptyLines: "greedy" });
    } catch (e) {
      out.error = String(e && e.message ? e.message : e);
      out.quality.push("CSV 解析失敗");
      return out;
    }

    if (parsed.errors && parsed.errors.length) {
      const msg = parsed.errors[0].message || "parse error";
      out.quality.push("PapaParse: " + msg);
    }

    const rows = parsed.data || [];
    if (!rows.length) {
      out.error = "無資料列";
      out.quality.push("無資料列");
      return out;
    }

    out.ok = true;
    out.complete = rowIsComplete(rows);
    const demo = getDemoRow(rows);
    out.demo = demo;
    out.participant = demo ? trimStr(demo.participant) : "";

    const rawFormal = getRawFormalTrialRows(rows);
    out.formalCount = rawFormal.length;

    if (!out.complete && rawFormal.length > 0) {
      out.quality.push("未完成實驗（無 thanksroutine.started）");
    }

    if (out.complete) {
      out.trials = buildEightyTrialsFromRows(rawFormal, out.participant, name, out.quality);
      if (rawFormal.length !== EXPECTED_TRIALS) {
        out.quality.push(
          "CSV 內正式試次列數為 " +
            rawFormal.length +
            "（已補齊／逾時未答列並固定為 " +
            EXPECTED_TRIALS +
            " 筆納入統計）"
        );
      }
    } else {
      out.trials = [];
    }

    return out;
  }

  function mergeQuality(files) {
    const incomplete = [];
    const badTrialCount = [];
    const loadErrors = [];
    const other = [];

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (!f.ok) {
        loadErrors.push({ file: f.fileName, msg: f.error || "讀取失敗" });
        continue;
      }
      if (!f.complete) incomplete.push(f.fileName);
      if (f.complete && f.trials.length !== EXPECTED_TRIALS) {
        badTrialCount.push(
          f.fileName + "（完成標記有誤：試次數=" + f.trials.length + "，預期 " + EXPECTED_TRIALS + "）"
        );
      }
      for (let q = 0; q < f.quality.length; q++) {
        const line = f.fileName + ": " + f.quality[q];
        if (other.indexOf(line) === -1) other.push(line);
      }
    }

    return { incomplete, badTrialCount, loadErrors, other };
  }

  function buildItemMap(completedFiles) {
    const map = new Map();
    for (let fi = 0; fi < completedFiles.length; fi++) {
      const f = completedFiles[fi];
      for (let ti = 0; ti < f.trials.length; ti++) {
        const t = f.trials[ti];
        if (t.imputed) continue;
        let rec = map.get(t.key);
        if (!rec) {
          rec = {
            key: t.key,
            漢字: t.漢字,
            臺羅: trimStr(t.臺羅),
            分組: t.分組,
            ab組: t.ab組,
            isword: t.isword,
            台語詞頻分組: t.台語詞頻分組,
            華語詞頻分組: t.華語詞頻分組,
            ifile: t.ifile,
            rts: [],
            rtsCorrect: [],
            corrs: [],
          };
          map.set(t.key, rec);
        } else if (!trimStr(rec.臺羅) && trimStr(t.臺羅)) {
          rec.臺羅 = trimStr(t.臺羅);
        }
        rec.rts.push(t.rtMs);
        if (t.corr === 1) rec.rtsCorrect.push(t.rtMs);
        rec.corrs.push(t.corr);
      }
    }
    return map;
  }

  function itemRowStats(rec) {
    const n = rec.corrs.length;
    const acc = n ? mean(rec.corrs) : NaN;
    const mAll = mean(rec.rts);
    const sdAll = sdSample(rec.rts);
    const mCor = rec.rtsCorrect.length ? mean(rec.rtsCorrect) : NaN;
    const sdCor = rec.rtsCorrect.length >= 2 ? sdSample(rec.rtsCorrect) : NaN;
    return { n, acc, mAll, sdAll, mCor, sdCor };
  }

  function aggregateByAbGroup(completedFiles) {
    const buckets = new Map();
    for (let fi = 0; fi < completedFiles.length; fi++) {
      for (let ti = 0; ti < completedFiles[fi].trials.length; ti++) {
        const t = completedFiles[fi].trials[ti];
        const g = t.ab組 || AB_GROUP_OTHER;
        let b = buckets.get(g);
        if (!b) {
          b = { rts: [], rtsCorrect: [], corrs: [] };
          buckets.set(g, b);
        }
        b.rts.push(t.rtMs);
        if (t.corr === 1) b.rtsCorrect.push(t.rtMs);
        b.corrs.push(t.corr);
      }
    }
    const rest = Array.from(buckets.keys()).filter((k) => AB_GROUP_ORDER.indexOf(k) === -1);
    rest.sort();
    const labels = AB_GROUP_ORDER.filter((k) => buckets.has(k)).concat(rest);
    const meanRtCorr = labels.map((lab) => {
      const b = buckets.get(lab);
      return b.rtsCorrect.length ? mean(b.rtsCorrect) : null;
    });
    const meanAcc = labels.map((lab) => mean(buckets.get(lab).corrs));
    return { labels, meanRtCorr, meanAcc };
  }

  function renderStatCards(el, stats) {
    el.innerHTML =
      '<div class="stat-grid">' +
      '<div class="stat-card"><div class="num">' +
      stats.manifestCount +
      '</div><div class="lbl">清單中的檔案數</div></div>' +
      '<div class="stat-card"><div class="num">' +
      stats.loadedOk +
      '</div><div class="lbl">成功解析</div></div>' +
      '<div class="stat-card"><div class="num">' +
      stats.completed +
      '</div><div class="lbl">完成實驗（納入統計）</div></div>' +
      '<div class="stat-card"><div class="num">' +
      stats.incomplete +
      '</div><div class="lbl">未完成</div></div>' +
      '<div class="stat-card"><div class="num">' +
      stats.totalTrials +
      '</div><div class="lbl">納入之正式試次總數</div></div>' +
      "</div>";
  }

  function plotHistogram(elId, ages, title) {
    const el = document.getElementById(elId);
    if (!el) return;
    const valid = ages.filter((a) => Number.isFinite(a) && a > 0 && a < 120);
    if (!valid.length) {
      Plotly.react(el, [], { ...plotlyLayoutBase, title: { text: title + "（無有效資料）" } }, { responsive: true });
      return;
    }
    Plotly.react(
      el,
      [
        {
          type: "histogram",
          x: valid,
          nbinsx: Math.min(15, Math.max(5, Math.ceil(valid.length / 3))),
          marker: { color: "#2980b9" },
        },
      ],
      {
        ...plotlyLayoutBase,
        title: { text: title },
        xaxis: { title: "年齡（歲）" },
        yaxis: { title: "人數" },
      },
      { responsive: true }
    );
  }

  function plotBarCounts(elId, labels, values, title, xTitle) {
    const el = document.getElementById(elId);
    if (!el) return;
    Plotly.react(
      el,
      [
        {
          type: "bar",
          x: labels,
          y: values,
          marker: { color: "#2980b9" },
        },
      ],
      {
        ...plotlyLayoutBase,
        title: { text: title },
        xaxis: { title: xTitle },
        yaxis: { title: "人數" },
      },
      { responsive: true }
    );
  }

  function plotGroupRt(elId, labels, rtMs) {
    const el = document.getElementById(elId);
    if (!el) return;
    const y = labels.map((_, i) => (rtMs[i] == null ? null : rtMs[i]));
    const text = labels.map((_, i) => (rtMs[i] == null ? "—" : Math.round(rtMs[i]) + " ms"));
    const customdata = labels.map((lab) => [abGroupDefinitionText(lab)]);
    Plotly.react(
      el,
      [
        {
          type: "bar",
          x: labels,
          y,
          text,
          textposition: "outside",
          marker: { color: "#2980b9" },
          customdata,
          hovertemplate:
            "<b>%{x}</b><br>%{customdata[0]}<br><br>平均 RT（僅正確）：%{y:.0f} ms<extra></extra>",
        },
      ],
      {
        ...plotlyLayoutBase,
        title: { text: "依實驗組別（A–F）：正確試次之平均 RT" },
        xaxis: { title: "組別", tickangle: 0 },
        yaxis: { title: "RT（ms）" },
        margin: { ...plotlyLayoutBase.margin, b: 56 },
        hoverlabel: { align: "left", font: { size: 12 } },
      },
      { responsive: true }
    );
  }

  function plotGroupAcc(elId, labels, acc) {
    const el = document.getElementById(elId);
    if (!el) return;
    const customdata = labels.map((lab) => [abGroupDefinitionText(lab)]);
    Plotly.react(
      el,
      [
        {
          type: "bar",
          x: labels,
          y: acc.map((a) => (Number.isFinite(a) ? a * 100 : null)),
          text: acc.map((a) => (Number.isFinite(a) ? (a * 100).toFixed(1) + "%" : "—")),
          textposition: "outside",
          marker: { color: "#1e8449" },
          customdata,
          hovertemplate:
            "<b>%{x}</b><br>%{customdata[0]}<br><br>正確率：%{y:.1f}%<extra></extra>",
        },
      ],
      {
        ...plotlyLayoutBase,
        title: { text: "依實驗組別（A–F）：正確率" },
        xaxis: { title: "組別", tickangle: 0 },
        yaxis: { title: "正確率（%）", range: [0, 105] },
        margin: { ...plotlyLayoutBase.margin, b: 56 },
        hoverlabel: { align: "left", font: { size: 12 } },
      },
      { responsive: true }
    );
  }

  function abGroupsInItemMap(itemMap) {
    const present = new Set();
    itemMap.forEach((rec) => present.add(rec.ab組 || AB_GROUP_OTHER));
    const ordered = [];
    for (let i = 0; i < AB_GROUP_ORDER.length; i++) {
      if (present.has(AB_GROUP_ORDER[i])) ordered.push(AB_GROUP_ORDER[i]);
    }
    const rest = Array.from(present).filter((k) => AB_GROUP_ORDER.indexOf(k) === -1);
    rest.sort();
    return ordered.concat(rest);
  }

  /** 字卡右上角：isword 1 真詞／0 假詞；無欄位則不顯示徽章 */
  function stimWordTypeBadge(isword) {
    const s = String(isword).trim();
    if (s === "1") return { text: "真詞", cls: "stim-badge stim-badge--real" };
    if (s === "0") return { text: "假詞", cls: "stim-badge stim-badge--pseudo" };
    return null;
  }

  /** 詞頻標籤底色依「懸／低」區分；其餘值用中性樣式 */
  function stimFreqTagClass(freqVal) {
    const f = trimStr(freqVal);
    if (f === "懸") return "stim-tag stim-tag--freq-xuan";
    if (f === "低") return "stim-tag stim-tag--freq-di";
    return "stim-tag stim-tag--freq-other";
  }

  function renderBrowseAbCards(host, itemMap, letter) {
    if (!host) return;
    host.innerHTML = "";
    const items = [];
    itemMap.forEach((rec) => {
      if ((rec.ab組 || AB_GROUP_OTHER) !== letter) return;
      items.push(rec);
    });
    items.sort((a, b) => {
      const ka = String(a.ifile || a.漢字 || a.臺羅 || "");
      const kb = String(b.ifile || b.漢字 || b.臺羅 || "");
      return ka.localeCompare(kb, "zh-Hant");
    });
    if (!items.length) {
      const p = document.createElement("p");
      p.className = "subtext";
      p.textContent = "目前載入的完成資料中，此組尚無題目列。";
      host.appendChild(p);
      return;
    }
    const grid = document.createElement("div");
    grid.className = "browse-stim-grid";
    for (let i = 0; i < items.length; i++) {
      const rec = items[i];
      const han = trimStr(rec.漢字);
      const tl = trimStr(rec.臺羅);
      const twFreq = trimStr(rec.台語詞頻分組);
      const huaFreq = trimStr(rec.華語詞頻分組);
      const badge = stimWordTypeBadge(rec.isword);

      const inner = document.createElement("div");
      inner.className = "stim-card-inner";
      if (han) {
        const el = document.createElement("div");
        el.className = "stim-han";
        el.textContent = han;
        inner.appendChild(el);
      }
      if (tl) {
        const el = document.createElement("div");
        el.className = "stim-tl";
        el.textContent = tl;
        inner.appendChild(el);
      }

      if (twFreq || huaFreq) {
        const tags = document.createElement("div");
        tags.className = "stim-tags";
        if (twFreq) {
          const t = document.createElement("span");
          t.className = stimFreqTagClass(twFreq);
          t.textContent = "台語詞頻：" + twFreq;
          tags.appendChild(t);
        }
        if (huaFreq) {
          const t = document.createElement("span");
          t.className = stimFreqTagClass(huaFreq);
          t.textContent = "華語詞頻：" + huaFreq;
          tags.appendChild(t);
        }
        inner.appendChild(tags);
      }

      if (!inner.firstChild && !badge) continue;

      const card = document.createElement("article");
      card.className = "stim-card" + (badge ? "" : " stim-card--no-badge");
      if (badge) {
        const b = document.createElement("span");
        b.className = badge.cls;
        b.textContent = badge.text;
        card.appendChild(b);
      }
      if (inner.firstChild) card.appendChild(inner);
      grid.appendChild(card);
    }
    if (!grid.children.length) {
      const p = document.createElement("p");
      p.className = "subtext";
      p.textContent = "此組題目在資料中尚無漢字、臺羅或詞頻欄位可顯示。";
      host.appendChild(p);
      return;
    }
    host.appendChild(grid);
  }

  function uniqueSorted(values) {
    const s = new Set();
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      s.add(v || "（空白）");
    }
    return Array.from(s).sort();
  }

  function fillSelect(sel, options, withAll) {
    const cur = sel.value;
    sel.innerHTML = "";
    if (withAll) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = "全部";
      sel.appendChild(o);
    }
    for (let i = 0; i < options.length; i++) {
      const o = document.createElement("option");
      o.value = options[i];
      o.textContent = options[i];
      sel.appendChild(o);
    }
    if (cur && Array.prototype.some.call(sel.options, (op) => op.value === cur)) sel.value = cur;
  }

  function fmtNum(x, digits) {
    if (!Number.isFinite(x)) return "—";
    return x.toFixed(digits);
  }

  function renderItemTable(tbody, itemMap, filters) {
    tbody.innerHTML = "";
    const rows = [];
    itemMap.forEach((rec) => {
      if (filters.ab組 && rec.ab組 !== filters.ab組) return;
      if (filters.分組 && rec.分組 !== filters.分組) return;
      if (filters.isword !== "" && String(rec.isword) !== filters.isword) return;
      if (filters.tw && (rec.台語詞頻分組 || "（空白）") !== filters.tw) return;
      if (filters.hua && (rec.華語詞頻分組 || "（空白）") !== filters.hua) return;
      rows.push(rec);
    });
    rows.sort((a, b) => {
      const sa = itemRowStats(a);
      const sb = itemRowStats(b);
      return (sb.n || 0) - (sa.n || 0);
    });

    for (let i = 0; i < rows.length; i++) {
      const rec = rows[i];
      const st = itemRowStats(rec);
      const tr = document.createElement("tr");
      const cells = [
        rec.漢字 || "—",
        rec.ifile || "—",
        rec.ab組 || "—",
        rec.分組 || "—",
        String(rec.isword !== "" ? rec.isword : "—"),
        rec.台語詞頻分組 || "—",
        rec.華語詞頻分組 || "—",
        String(st.n),
        fmtNum(st.acc * 100, 1) + "%",
        fmtNum(st.mAll, 0),
        fmtNum(st.sdAll, 0),
        fmtNum(st.mCor, 0),
        fmtNum(st.sdCor, 0),
      ];
      for (let c = 0; c < cells.length; c++) {
        const td = document.createElement("td");
        td.textContent = cells[c];
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  }

  function renderQualityTables(host, q, certUnmappedLines) {
    host.innerHTML = "";

    function block(title, items, cls) {
      const wrap = document.createElement("div");
      wrap.className = "quality-block";
      const h = document.createElement("h3");
      h.textContent = title;
      wrap.appendChild(h);
      if (!items.length) {
        const p = document.createElement("p");
        p.className = "subtext";
        p.textContent = "無";
        wrap.appendChild(p);
        host.appendChild(wrap);
        return;
      }
      const ul = document.createElement("ul");
      ul.className = cls || "";
      for (let i = 0; i < items.length; i++) {
        const li = document.createElement("li");
        li.textContent = typeof items[i] === "string" ? items[i] : items[i].file + " — " + items[i].msg;
        ul.appendChild(li);
      }
      wrap.appendChild(ul);
      host.appendChild(wrap);
    }

    block("載入或解析失敗", q.loadErrors);
    block("未完成實驗（未納入統計）", q.incomplete, "warn-list");
    block("已完成但試次數異常", q.badTrialCount, "warn-list");
    if (certUnmappedLines && certUnmappedLines.length) {
      block(
        "台語檢定成績：尚無標準化規則之原始填答（圖表暫歸「（待標準化）」；可於 ldt-report.js 的 normalizeCert 增列對應）",
        certUnmappedLines,
        "warn-list"
      );
    }
    block("其他提示", q.other);
  }

  async function run() {
    const statusEl = document.getElementById("load-status");
    const cardsEl = document.getElementById("stat-cards");
    const qualityHost = document.getElementById("quality-detail");
    const tbody = document.getElementById("item-table-body");
    const sel分組 = document.getElementById("filter-分組");
    const selIsword = document.getElementById("filter-isword");
    const selTw = document.getElementById("filter-tw");
    const selHua = document.getElementById("filter-hua");

    statusEl.textContent = "載入清單…";

    let manifest;
    try {
      const res = await fetch(MANIFEST_URL, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      manifest = await res.json();
    } catch (e) {
      statusEl.textContent = "無法載入 data-manifest.json：" + (e && e.message ? e.message : e);
      return;
    }

    const paths = Array.isArray(manifest.files) ? manifest.files : [];
    statusEl.textContent = "讀取 " + paths.length + " 個 CSV…";

    const files = [];
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      try {
        const res = await fetch(encodeURI(p), { cache: "no-store" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const text = await res.text();
        files.push(processOneFile(text, p));
      } catch (e) {
        files.push({
          fileName: p.split("/").pop(),
          sourcePath: p,
          ok: false,
          error: e && e.message ? e.message : String(e),
          complete: false,
          participant: "",
          demo: null,
          formalCount: 0,
          trials: [],
          quality: ["無法 fetch 檔案"],
        });
      }
    }

    const completed = files.filter(
      (f) => f.ok && f.complete && f.trials.length === EXPECTED_TRIALS
    );
    const q = mergeQuality(files);

    const ages = [];
    const genders = [];
    const certs = [];
    const certUnmappedLines = [];
    for (let i = 0; i < completed.length; i++) {
      const d = completed[i].demo;
      if (!d) continue;
      const age = parseNum(d["年齡"]);
      if (Number.isFinite(age)) ages.push(age);
      genders.push(normalizeGender(d["性別"]));
      const certNorm = normalizeCert(d["台語檢定成績"]);
      certs.push(certNorm.level);
      if (certNorm.unmappedRaw != null) {
        certUnmappedLines.push(
          completed[i].fileName +
            "：原始填答「" +
            certNorm.unmappedRaw +
            "」尚無標準化規則，圖表暫歸「（待標準化）」"
        );
      }
    }

    const genderLabels = ["男", "女", "其他", "未知"];
    const genderCounts = genderLabels.map((g) => genders.filter((x) => x === g).length);
    const uniqCert = Array.from(new Set(certs)).sort((a, b) => certSortKey(a) - certSortKey(b));
    const certCounts = uniqCert.map((lab) => certs.filter((c) => c === lab).length);

    const totalTrials = completed.reduce((s, f) => s + f.trials.length, 0);

    renderStatCards(cardsEl, {
      manifestCount: paths.length,
      loadedOk: files.filter((f) => f.ok).length,
      completed: completed.length,
      incomplete: files.filter((f) => f.ok && !f.complete).length,
      totalTrials,
    });

    plotHistogram("chart-age", ages, "年齡分布（完成實驗者）");
    plotBarCounts("chart-gender", genderLabels, genderCounts, "性別分布（正規化後）", "類別");
    plotBarCounts("chart-cert", uniqCert, certCounts, "台語檢定最高等級（標準化：未考取／A1–C2）", "等級");

    const grp = aggregateByAbGroup(completed);
    plotGroupRt("chart-by-group-rt", grp.labels, grp.meanRtCorr);
    plotGroupAcc("chart-by-group-acc", grp.labels, grp.meanAcc);

    const itemMap = buildItemMap(completed);
    const all分組 = uniqueSorted(
      Array.from(itemMap.values()).map((r) => r.分組 || "（空白）")
    );
    const allAb = abGroupsInItemMap(itemMap);
    const allIs = uniqueSorted(Array.from(itemMap.values()).map((r) => String(r.isword)));
    const allTw = uniqueSorted(Array.from(itemMap.values()).map((r) => r.台語詞頻分組));
    const allHua = uniqueSorted(Array.from(itemMap.values()).map((r) => r.華語詞頻分組));

    const selAb = document.getElementById("filter-ab組");
    const browseSel = document.getElementById("browse-ab-select");
    const browseHost = document.getElementById("browse-ab-cards-host");

    if (selAb) fillSelect(selAb, allAb, true);
    fillSelect(sel分組, all分組, true);
    fillSelect(selIsword, allIs, true);
    fillSelect(selTw, allTw, true);
    fillSelect(selHua, allHua, true);

    if (browseSel && browseHost) {
      browseSel.innerHTML = "";
      if (!allAb.length) {
        const o = document.createElement("option");
        o.value = "";
        o.textContent = "（無完成資料之題目）";
        browseSel.appendChild(o);
        browseHost.innerHTML = "";
        const p = document.createElement("p");
        p.className = "subtext";
        p.textContent = "尚無已完成實驗之 CSV，無法列出題目。";
        browseHost.appendChild(p);
      } else {
        for (let i = 0; i < allAb.length; i++) {
          const lab = allAb[i];
          const o = document.createElement("option");
          o.value = lab;
          o.textContent = lab + " 組";
          browseSel.appendChild(o);
        }
        browseSel.value = allAb[0];
        renderBrowseAbCards(browseHost, itemMap, browseSel.value);
        browseSel.onchange = function () {
          renderBrowseAbCards(browseHost, itemMap, browseSel.value);
        };
      }
    }

    function applyFilters() {
      renderItemTable(tbody, itemMap, {
        ab組: selAb ? selAb.value : "",
        分組: sel分組.value,
        isword: selIsword.value,
        tw: selTw.value,
        hua: selHua.value,
      });
    }

    if (selAb) selAb.onchange = applyFilters;
    sel分組.onchange = applyFilters;
    selIsword.onchange = applyFilters;
    selTw.onchange = applyFilters;
    selHua.onchange = applyFilters;

    applyFilters();
    renderQualityTables(qualityHost, q, certUnmappedLines);

    statusEl.textContent =
      "已載入 " +
      files.length +
      " 個檔案；納入統計 " +
      completed.length +
      " 人、" +
      totalTrials +
      " 筆試次。";
  }

  global.LDT_REPORT_RUN = run;
})(typeof window !== "undefined" ? window : this);
