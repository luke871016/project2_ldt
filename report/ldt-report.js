/* global Papa, Plotly, jStat */
"use strict";

(function (global) {
  const MANIFEST_URL = "data-manifest.json";
  /** 由 scripts/build_ldt_dataset.py 產生；存在時只發一次請求 */
  const DATASET_URL = "ldt-dataset.json";
  const EXPECTED_TRIALS = 80;
  /** 題目最長等待秒數；未按鍵逾時列視為錯誤並以此毫秒計 RT */
  const NO_RESPONSE_RT_MS = 5000;
  const MANUAL_EXCLUDE_STORAGE_KEY = "ldtReportManualExcludedSubjectsV1";
  const SUBJECT_PICK_STORAGE_KEY = "ldtReportSubjectPickerCurrentV1";

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
  const CERT_ORDER = [
    "未考取",
    "A1",
    "A2",
    "B1",
    "B2",
    "C1",
    "C2",
    "（待標準化）",
  ];

  const plotlyLayoutBase = {
    font: {
      family: '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif',
      size: 12,
    },
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
    if (/^(A1|A2|B1|B2|C1|C2)$/.test(lat))
      return { level: lat, unmappedRaw: null };

    if (/^(無|沒有|沒考|未考|未考取|無檢定|N\/A|NA|NONE)$/i.test(t0)) {
      return { level: "未考取", unmappedRaw: null };
    }

    if (/教育部B卷205/i.test(t0)) return { level: "B1", unmappedRaw: null };
    if (t0 === "教育部B1" || /^教育部\s*B1$/i.test(t0))
      return { level: "B1", unmappedRaw: null };

    if (t0 === "教育部高級") return { level: "C1", unmappedRaw: null };
    if (t0 === "高級") return { level: "C1", unmappedRaw: null };
    if (t0 === "422") return { level: "C1", unmappedRaw: null };
    if (t0 === "通過C2") return { level: "C2", unmappedRaw: null };

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

  /** 單人作答區：年齡、性別、台語檢定（與第 4 節圖表相同之正規化規則） */
  function subjectTrialDemoSummary(file) {
    const d = file && file.demo;
    if (!d) {
      return "年齡：—　性別：—　台語檢定最高等級：—";
    }
    const ageRaw = parseNum(d["年齡"]);
    const ageStr = Number.isFinite(ageRaw) ? String(Math.round(ageRaw)) : "—";
    const gender = normalizeGender(d["性別"]);
    const certLevel = normalizeCert(d["台語檢定成績"]).level;
    return (
      "年齡：" +
      ageStr +
      "　性別：" +
      gender +
      "　台語檢定最高等級：" +
      certLevel
    );
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
        quality.push(
          "缺 trialloop.thisN=" +
            n +
            " 列，已以 " +
            NO_RESPONSE_RT_MS +
            "ms、錯誤補齊",
        );
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
    if (
      /filler_假詞/.test(grp) ||
      (grp.includes("假詞") && !grp.includes("純台語"))
    )
      return "F";
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

  function safeLocalStorageGet(key) {
    try {
      if (typeof localStorage === "undefined") return null;
      return localStorage.getItem(key);
    } catch (_err) {
      return null;
    }
  }

  function safeLocalStorageSet(key, value) {
    try {
      if (typeof localStorage === "undefined") return;
      localStorage.setItem(key, value);
    } catch (_err) {
      // Ignore storage errors (private mode / quota / policy).
    }
  }

  function subjectIdentityKey(file) {
    if (!file) return "";
    const pid = trimStr(file.participant) || "—";
    const fileName = trimStr(file.fileName) || "—";
    return fileName + "::" + pid;
  }

  function loadManualExcludedSet() {
    const raw = safeLocalStorageGet(MANUAL_EXCLUDE_STORAGE_KEY);
    if (!raw) return new Set();
    try {
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return new Set();
      const out = new Set();
      for (let i = 0; i < arr.length; i++) {
        const key = trimStr(arr[i]);
        if (key) out.add(key);
      }
      return out;
    } catch (_err) {
      return new Set();
    }
  }

  function saveManualExcludedSet(setObj) {
    const arr = Array.from(setObj).sort();
    safeLocalStorageSet(MANUAL_EXCLUDE_STORAGE_KEY, JSON.stringify(arr));
  }

  /**
   * @param {Array<Record<string, unknown>>} rows Papa.parse 或合併 JSON 之列資料
   * @param {string[]} [extraQuality] 先併入 quality 的提示（例如 Papa 解析警告）
   */
  function finalizeFromRows(rows, sourcePath, extraQuality) {
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
      quality: extraQuality ? extraQuality.slice() : [],
    };

    if (!rows || !rows.length) {
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
      out.trials = buildEightyTrialsFromRows(
        rawFormal,
        out.participant,
        name,
        out.quality,
      );
      if (rawFormal.length !== EXPECTED_TRIALS) {
        out.quality.push(
          "CSV 內正式試次列數為 " +
            rawFormal.length +
            "（已補齊／逾時未答列並固定為 " +
            EXPECTED_TRIALS +
            " 筆納入統計）",
        );
      }
    } else {
      out.trials = [];
    }

    return out;
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

    const quality = [];
    if (parsed.errors && parsed.errors.length) {
      const msg = parsed.errors[0].message || "parse error";
      quality.push("PapaParse: " + msg);
    }

    const rows = parsed.data || [];
    return finalizeFromRows(rows, sourcePath, quality);
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
          f.fileName +
            "（完成標記有誤：試次數=" +
            f.trials.length +
            "，預期 " +
            EXPECTED_TRIALS +
            "）",
        );
      }
      for (let q = 0; q < f.quality.length; q++) {
        const line = f.fileName + ": " + f.quality[q];
        if (other.indexOf(line) === -1) other.push(line);
      }
    }

    return { incomplete, badTrialCount, loadErrors, other };
  }

  /**
   * 正式試次無任一 corr===1（全錯或逾時等）— 極端資料，不納入回答分析。
   */
  function fileAllTrialsIncorrect(f) {
    if (!f || !f.trials || !f.trials.length) return false;
    for (let i = 0; i < f.trials.length; i++) {
      if (f.trials[i].corr === 1) return false;
    }
    return true;
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
    const rest = Array.from(buckets.keys()).filter(
      (k) => AB_GROUP_ORDER.indexOf(k) === -1,
    );
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
      stats.completedEighty +
      '</div><div class="lbl">完成實驗（八十題）</div></div>' +
      '<div class="stat-card"><div class="num">' +
      stats.inAnalysis +
      '</div><div class="lbl">納入回答分析</div></div>' +
      '<div class="stat-card"><div class="num">' +
      stats.incomplete +
      '</div><div class="lbl">未完成</div></div>' +
      '<div class="stat-card"><div class="num">' +
      stats.totalTrials +
      '</div><div class="lbl">納入分析之試次總數</div></div>' +
      "</div>";
  }

  function plotHistogram(elId, ages, title) {
    const el = document.getElementById(elId);
    if (!el) return;
    const valid = ages.filter((a) => Number.isFinite(a) && a > 0 && a < 120);
    if (!valid.length) {
      Plotly.react(
        el,
        [],
        { ...plotlyLayoutBase, title: { text: title + "（無有效資料）" } },
        { responsive: true },
      );
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
      { responsive: true },
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
      { responsive: true },
    );
  }

  function plotGroupRt(elId, labels, rtMs) {
    const el = document.getElementById(elId);
    if (!el) return;
    const y = labels.map((_, i) => (rtMs[i] == null ? null : rtMs[i]));
    const finiteY = y.filter((v) => Number.isFinite(v));
    const yMax = finiteY.length ? Math.max.apply(null, finiteY) : 0;
    const yTop = yMax > 0 ? yMax * 1.12 : null;
    const text = labels.map((_, i) =>
      rtMs[i] == null ? "—" : Math.round(rtMs[i]) + " ms",
    );
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
          cliponaxis: false,
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
        yaxis: {
          title: "RT（ms）",
          range: yTop ? [0, yTop] : undefined,
        },
        margin: { ...plotlyLayoutBase.margin, b: 56, t: 56 },
        hoverlabel: { align: "left", font: { size: 12 } },
      },
      { responsive: true },
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
          text: acc.map((a) =>
            Number.isFinite(a) ? (a * 100).toFixed(1) + "%" : "—",
          ),
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
      { responsive: true },
    );
  }

  /** 雙尾 p 值：Student t(df)；若無 jStat 則大樣本時退回常態近似 */
  function tDistTwoTailP(t, df) {
    if (!Number.isFinite(t) || !(df > 0)) return NaN;
    const a = Math.abs(t);
    if (typeof jStat !== "undefined" && jStat.studentt && jStat.studentt.cdf) {
      const cdf = jStat.studentt.cdf(a, df);
      return Math.min(1, Math.max(0, 2 * (1 - cdf)));
    }
    if (df >= 80) {
      const z = a;
      const p = 2 * (1 - normalCdf(z));
      return Math.min(1, Math.max(0, p));
    }
    return NaN;
  }

  function normalCdf(x) {
    return 0.5 * (1 + erfApprox(x / Math.SQRT2));
  }

  function erfApprox(x) {
    const sign = x < 0 ? -1 : 1;
    const ax = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * ax);
    const p =
      (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
        t +
        0.254829592) *
        t) *
      Math.exp(-ax * ax);
    return sign * (1 - p);
  }

  function oneSampleTFromDiffs(diffs) {
    const arr = diffs.filter((x) => Number.isFinite(x));
    const n = arr.length;
    if (n < 2) {
      return {
        n,
        mean: n === 1 ? arr[0] : NaN,
        sd: NaN,
        se: NaN,
        t: NaN,
        df: NaN,
        p: NaN,
        dz: NaN,
        f: NaN,
        etaPartial: NaN,
      };
    }
    const m = mean(arr);
    const s = sdSample(arr);
    const se = s / Math.sqrt(n);
    const df = n - 1;
    const t = se > 0 ? m / se : NaN;
    const p = Number.isFinite(t) ? tDistTwoTailP(t, df) : NaN;
    const dz = s > 0 ? m / s : NaN;
    const f = Number.isFinite(t) ? t * t : NaN;
    const etaPartial =
      Number.isFinite(f) && df > 0 ? f / (f + df) : NaN;
    return { n, mean: m, sd: s, se, t, df, p, dz, f, etaPartial };
  }

  /**
   * 每位受試者在 A–D 各格：僅正確 RT 之平均、該格正確率、試次數。
   */
  function buildParticipantAbcdCells(completedFiles) {
    const letters = ["A", "B", "C", "D"];
    const out = [];
    for (let fi = 0; fi < completedFiles.length; fi++) {
      const f = completedFiles[fi];
      const cells = {};
      for (let li = 0; li < letters.length; li++) {
        cells[letters[li]] = { rtsCorr: [], corrs: [] };
      }
      for (let ti = 0; ti < f.trials.length; ti++) {
        const t = f.trials[ti];
        const g = t.ab組;
        if (!cells[g]) continue;
        if (t.corr === 1) cells[g].rtsCorr.push(t.rtMs);
        cells[g].corrs.push(t.corr);
      }
      const row = {
        participant: f.participant || f.fileName,
        fileName: f.fileName,
      };
      for (let li = 0; li < letters.length; li++) {
        const L = letters[li];
        const c = cells[L];
        row[L + "_rt"] = c.rtsCorr.length ? mean(c.rtsCorr) : NaN;
        row[L + "_acc"] = c.corrs.length ? mean(c.corrs) : NaN;
        row[L + "_n"] = c.corrs.length;
        row[L + "_nCorrRt"] = c.rtsCorr.length;
      }
      out.push(row);
    }
    return out;
  }

  function filterCompleteAbcd(rows, mode) {
    const letters = ["A", "B", "C", "D"];
    return rows.filter((r) => {
      for (let i = 0; i < letters.length; i++) {
        const L = letters[i];
        if (mode === "rt") {
          if (!Number.isFinite(r[L + "_rt"]) || r[L + "_nCorrRt"] < 1)
            return false;
        } else {
          if (!Number.isFinite(r[L + "_acc"]) || r[L + "_n"] < 1)
            return false;
        }
      }
      return true;
    });
  }

  /**
   * 受試者內 2×2 重複量數：華語主效應、台語主效應、交互作用之對比分。
   * 華語：( (A+B) − (C+D) ) / 2 = 華懸邊際 − 華低邊際（RT 或正確率之細格平均差）
   * 台語：( (A+C) − (B+D) ) / 2
   * 交互：A − B − C + D（可解讀為「華語效應在台語懸與台語低兩層之差」）
   */
  function rm2x2Contrasts(rows, mode) {
    const letters = ["A", "B", "C", "D"];
    const ok = filterCompleteAbcd(rows, mode);
    const suffix = mode === "rt" ? "_rt" : "_acc";
    function pull(r, L) {
      return r[L + suffix];
    }
    const chH = [];
    const chT = [];
    const chI = [];
    for (let i = 0; i < ok.length; i++) {
      const r = ok[i];
      const A = pull(r, "A");
      const B = pull(r, "B");
      const C = pull(r, "C");
      const D = pull(r, "D");
      chH.push((A + B - C - D) / 2);
      chT.push((A + C - B - D) / 2);
      chI.push(A - B - C + D);
    }
    return {
      rowsUsed: ok.length,
      rowsTotal: rows.length,
      hua: oneSampleTFromDiffs(chH),
      tai: oneSampleTFromDiffs(chT),
      interaction: oneSampleTFromDiffs(chI),
    };
  }

  /**
   * 簡單主要效果（受試者內 2×2）：華語效應在台語懸／低各一對比；台語效應在華語懸／低各一對比。
   * 台語＝懸：A−C；台語＝低：B−D；華語＝懸：A−B；華語＝低：C−D。
   */
  function rm2x2SimpleMainEffects(rows, mode) {
    const ok = filterCompleteAbcd(rows, mode);
    const suffix = mode === "rt" ? "_rt" : "_acc";
    function pull(r, L) {
      return r[L + suffix];
    }
    const dHuaTwXuan = [];
    const dHuaTwDi = [];
    const dTwHuaXuan = [];
    const dTwHuaDi = [];
    for (let i = 0; i < ok.length; i++) {
      const r = ok[i];
      const A = pull(r, "A");
      const B = pull(r, "B");
      const C = pull(r, "C");
      const D = pull(r, "D");
      dHuaTwXuan.push(A - C);
      dHuaTwDi.push(B - D);
      dTwHuaXuan.push(A - B);
      dTwHuaDi.push(C - D);
    }
    return {
      rowsUsed: ok.length,
      huaAtTaiXuan: oneSampleTFromDiffs(dHuaTwXuan),
      huaAtTaiDi: oneSampleTFromDiffs(dHuaTwDi),
      twAtHuaXuan: oneSampleTFromDiffs(dTwHuaXuan),
      twAtHuaDi: oneSampleTFromDiffs(dTwHuaDi),
    };
  }

  function cellMeansAndSem(rows, mode) {
    const letters = ["A", "B", "C", "D"];
    const suffix = mode === "rt" ? "_rt" : "_acc";
    const ok = filterCompleteAbcd(rows, mode);
    const stats = {};
    for (let li = 0; li < letters.length; li++) {
      const L = letters[li];
      const vals = ok.map((r) => r[L + suffix]).filter(Number.isFinite);
      const m = mean(vals);
      const s = vals.length >= 2 ? sdSample(vals) : NaN;
      const sem =
        vals.length >= 2 && Number.isFinite(s)
          ? s / Math.sqrt(vals.length)
          : 0;
      stats[L] = { m, sem, n: vals.length };
    }
    return stats;
  }

  function fmtP(p) {
    if (!Number.isFinite(p)) return "—";
    if (p < 0.0001) return "< .0001";
    if (p < 0.001) return "< .001";
    return p.toFixed(4);
  }

  function renderFreqRmAnovaTable(tableEl, rtRes, accRes) {
    if (!tableEl) return;
    const rows = [
      {
        label: "華語詞頻（懸 vs 低）",
        contrast: "(A+B−C−D)/2：邊際「華懸」−「華低」",
        rt: rtRes.hua,
        acc: accRes.hua,
      },
      {
        label: "台語詞頻（懸 vs 低）",
        contrast: "(A+C−B−D)/2：邊際「台懸」−「台低」",
        rt: rtRes.tai,
        acc: accRes.tai,
      },
      {
        label: "華語×台語交互作用",
        contrast: "A−B−C+D",
        rt: rtRes.interaction,
        acc: accRes.interaction,
      },
    ];
    let html =
      "<thead><tr><th>來源</th><th>對比</th><th colspan=\"5\">RT（ms，僅正確細格平均）</th><th colspan=\"5\">正確率（細格平均）</th></tr>";
    html +=
      "<tr><th></th><th></th><th>n</th><th>M<sub>diff</sub></th><th>t</th><th>p</th><th>d<sub>z</sub></th><th>n</th><th>M<sub>diff</sub></th><th>t</th><th>p</th><th>d<sub>z</sub></th></tr></thead><tbody>";
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const rt = r.rt;
      const ac = r.acc;
      html += "<tr><td>" + r.label + "</td><td>" + r.contrast + "</td>";
      html +=
        "<td>" +
        (rt.n != null ? String(rt.n) : "—") +
        "</td><td>" +
        fmtNum(rt.mean, 2) +
        "</td><td>" +
        fmtNum(rt.t, 3) +
        "</td><td>" +
        fmtP(rt.p) +
        "</td><td>" +
        fmtNum(rt.dz, 3) +
        "</td>";
      html +=
        "<td>" +
        (ac.n != null ? String(ac.n) : "—") +
        "</td><td>" +
        fmtNum(ac.mean, 4) +
        "</td><td>" +
        fmtNum(ac.t, 3) +
        "</td><td>" +
        fmtP(ac.p) +
        "</td><td>" +
        fmtNum(ac.dz, 3) +
        "</td></tr>";
    }
    html += "</tbody>";
    tableEl.innerHTML = html;
  }

  function renderFreqRmSimpleEffectsTable(tableEl, rtSme, accSme) {
    if (!tableEl) return;
    const rows = [
      {
        label: "華語（台語＝懸）",
        contrast: "A − C：華懸台懸 vs 華低台懸",
        rt: rtSme.huaAtTaiXuan,
        acc: accSme.huaAtTaiXuan,
      },
      {
        label: "華語（台語＝低）",
        contrast: "B − D：華懸台低 vs 華低台低",
        rt: rtSme.huaAtTaiDi,
        acc: accSme.huaAtTaiDi,
      },
      {
        label: "台語（華語＝懸）",
        contrast: "A − B：華懸台懸 vs 華懸台低",
        rt: rtSme.twAtHuaXuan,
        acc: accSme.twAtHuaXuan,
      },
      {
        label: "台語（華語＝低）",
        contrast: "C − D：華低台懸 vs 華低台低",
        rt: rtSme.twAtHuaDi,
        acc: accSme.twAtHuaDi,
      },
    ];
    let html =
      "<thead><tr><th>簡單主要效果</th><th>受試者內對比</th><th colspan=\"5\">RT（ms）</th><th colspan=\"5\">正確率</th></tr>";
    html +=
      "<tr><th></th><th></th><th>n</th><th>M<sub>diff</sub></th><th>t</th><th>p</th><th>d<sub>z</sub></th><th>n</th><th>M<sub>diff</sub></th><th>t</th><th>p</th><th>d<sub>z</sub></th></tr></thead><tbody>";
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const rt = r.rt;
      const ac = r.acc;
      html += "<tr><td>" + r.label + "</td><td>" + r.contrast + "</td>";
      html +=
        "<td>" +
        (rt.n != null ? String(rt.n) : "—") +
        "</td><td>" +
        fmtNum(rt.mean, 2) +
        "</td><td>" +
        fmtNum(rt.t, 3) +
        "</td><td>" +
        fmtP(rt.p) +
        "</td><td>" +
        fmtNum(rt.dz, 3) +
        "</td>";
      html +=
        "<td>" +
        (ac.n != null ? String(ac.n) : "—") +
        "</td><td>" +
        fmtNum(ac.mean, 4) +
        "</td><td>" +
        fmtNum(ac.t, 3) +
        "</td><td>" +
        fmtP(ac.p) +
        "</td><td>" +
        fmtNum(ac.dz, 3) +
        "</td></tr>";
    }
    html += "</tbody>";
    tableEl.innerHTML = html;
  }

  function freqRmSmeIntroText(rtRes, accRes, alpha) {
    const a = alpha != null ? alpha : 0.05;
    const sigRt =
      Number.isFinite(rtRes.interaction.p) && rtRes.interaction.p < a;
    const sigAcc =
      Number.isFinite(accRes.interaction.p) && accRes.interaction.p < a;
    let s =
      "交互作用對比（A−B−C+D）之結果：RT 之 p = " +
      fmtP(rtRes.interaction.p) +
      "；正確率之 p = " +
      fmtP(accRes.interaction.p) +
      "（顯著水準 α = " +
      a +
      "）。 ";
    if (sigRt && sigAcc) {
      s +=
        "兩指標之交互作用皆達顯著，故將華語、台語主效應分別在另一因子各水準下拆解為下列簡單主要效果。";
    } else if (sigRt || sigAcc) {
      s +=
        "其中" +
        (sigRt ? "RT" : "正確率") +
        "之交互作用達顯著；以下簡單主要效果仍一併列出兩指標，以利對照（未顯著者解讀宜保守）。";
    } else {
      s +=
        "此樣本中交互作用未同時於兩指標達上述顯著水準；下列簡單主要效果仍為標準分解方式，供補充檢視。";
    }
    return s;
  }

  function plotFreqInteractionLines(
    elId,
    cellStats,
    title,
    yTitle,
    valueForAccAsPercent,
  ) {
    const el = document.getElementById(elId);
    if (!el) return;
    const finite =
      cellStats &&
      ["A", "B", "C", "D"].every(
        (L) => cellStats[L] && Number.isFinite(cellStats[L].m),
      );
    if (!finite) {
      Plotly.react(
        el,
        [],
        {
          ...plotlyLayoutBase,
          title: { text: title + "（無足夠資料）" },
          annotations: [
            {
              text: "無可繪製之跨人平均（受試者人數或完整細格不足）",
              xref: "paper",
              yref: "paper",
              x: 0.5,
              y: 0.5,
              showarrow: false,
              font: { size: 13, color: "#5d6d7e" },
            },
          ],
        },
        { responsive: true },
      );
      return;
    }
    const xLabs = ["華語懸", "華語低"];
    const traceTwXuan = {
      type: "scatter",
      mode: "lines+markers",
      name: "台語懸",
      x: xLabs,
      xaxis: "x",
      y: [cellStats.A.m, cellStats.C.m],
      error_y: {
        type: "data",
        array: [cellStats.A.sem, cellStats.C.sem],
        visible: true,
        thickness: 1.2,
        width: 5,
      },
      line: { color: "#2980b9", width: 2.5 },
      marker: { size: 9 },
      hovertemplate:
        "%{fullData.name}<br>華語：%{x}<br>" +
        (valueForAccAsPercent ? "平均：%{y:.1f}%<br>" : "平均：%{y:.0f} ms<br>") +
        "SEM：%{error_y.array}<extra></extra>",
    };
    const traceTwTi = {
      type: "scatter",
      mode: "lines+markers",
      name: "台語低",
      x: xLabs,
      y: [cellStats.B.m, cellStats.D.m],
      error_y: {
        type: "data",
        array: [cellStats.B.sem, cellStats.D.sem],
        visible: true,
        thickness: 1.2,
        width: 5,
      },
      line: { color: "#d68910", dash: "dash", width: 2.5 },
      marker: { size: 9 },
      hovertemplate:
        "%{fullData.name}<br>華語：%{x}<br>" +
        (valueForAccAsPercent ? "平均：%{y:.1f}%<br>" : "平均：%{y:.0f} ms<br>") +
        "SEM：%{error_y.array}<extra></extra>",
    };
    let y0 = cellStats.A.m;
    let y1 = cellStats.B.m;
    let y2 = cellStats.C.m;
    let y3 = cellStats.D.m;
    if (valueForAccAsPercent) {
      y0 *= 100;
      y1 *= 100;
      y2 *= 100;
      y3 *= 100;
      traceTwXuan.y = [y0, y2];
      traceTwTi.y = [y1, y3];
      traceTwXuan.error_y.array = [
        cellStats.A.sem * 100,
        cellStats.C.sem * 100,
      ];
      traceTwTi.error_y.array = [
        cellStats.B.sem * 100,
        cellStats.D.sem * 100,
      ];
    }
    const yMin = Math.min(y0, y1, y2, y3);
    const yMax = Math.max(y0, y1, y2, y3);
    const pad = valueForAccAsPercent
      ? Math.max(3, (yMax - yMin) * 0.12)
      : Math.max(40, (yMax - yMin) * 0.12);
    Plotly.react(
      el,
      [traceTwXuan, traceTwTi],
      {
        ...plotlyLayoutBase,
        title: { text: title },
        xaxis: { title: "華語詞頻分組" },
        yaxis: {
          title: yTitle,
          range: valueForAccAsPercent
            ? [Math.max(0, yMin - pad), Math.min(100, yMax + pad)]
            : [Math.max(200, yMin - pad), yMax + pad],
        },
        legend: { orientation: "h", y: 1.08 },
        margin: { ...plotlyLayoutBase.margin, t: 52 },
        hoverlabel: { align: "left", font: { size: 12 } },
      },
      { responsive: true },
    );
  }

  function parseHexColor(hex) {
    const h = String(hex).replace(/^#/, "");
    if (h.length !== 6) return [0, 0, 0];
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
  }

  /** sRGB 0–255 → WCAG 相對亮度（0–1） */
  function relativeLuminanceFromRgb8(rgb) {
    function lin(c) {
      const x = c / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    }
    const R = lin(rgb[0]);
    const G = lin(rgb[1]);
    const B = lin(rgb[2]);
    return 0.2126 * R + 0.7152 * G + 0.0722 * B;
  }

  /** Plotly 分段 colorscale：t∈[0,1] 線性內插 RGB */
  function rgbAtColorscaleT(colorscale, t) {
    const stops = colorscale.map(function (row) {
      return { t0: row[0], rgb: parseHexColor(row[1]) };
    });
    stops.sort(function (a, b) {
      return a.t0 - b.t0;
    });
    const x = Math.max(0, Math.min(1, t));
    if (x <= stops[0].t0) return stops[0].rgb.slice();
    const last = stops[stops.length - 1];
    if (x >= last.t0) return last.rgb.slice();
    for (let i = 1; i < stops.length; i++) {
      if (x <= stops[i].t0) {
        const a = stops[i - 1];
        const b = stops[i];
        const span = b.t0 - a.t0;
        const u = span <= 1e-9 ? 0 : (x - a.t0) / span;
        return [
          Math.round(a.rgb[0] + u * (b.rgb[0] - a.rgb[0])),
          Math.round(a.rgb[1] + u * (b.rgb[1] - a.rgb[1])),
          Math.round(a.rgb[2] + u * (b.rgb[2] - a.rgb[2])),
        ];
      }
    }
    return last.rgb.slice();
  }

  /** 在底色上選白字或深字，使 WCAG 對比較佳 */
  function pickHeatmapLabelColor(bgRgb8) {
    const L = relativeLuminanceFromRgb8(bgRgb8);
    const Lw = 1;
    const Lb = 0;
    const crWhite = (Math.max(L, Lw) + 0.05) / (Math.min(L, Lw) + 0.05);
    const crBlack = (Math.max(L, Lb) + 0.05) / (Math.min(L, Lb) + 0.05);
    return crWhite >= crBlack ? "#ffffff" : "#2c3e50";
  }

  function heatmapCellLabelAnnotations(
    z00,
    z01,
    z10,
    z11,
    labels,
    colorScale,
  ) {
    const zMin = Math.min(z00, z01, z10, z11);
    const zMax = Math.max(z00, z01, z10, z11);
    const span = zMax - zMin;
    function colorForZ(z) {
      const t = span <= 1e-9 ? 0.5 : (z - zMin) / span;
      return rgbAtColorscaleT(colorScale, t);
    }
    const specs = [
      { x: "台語懸", y: "華語懸", z: z00, text: labels[0][0] },
      { x: "台語低", y: "華語懸", z: z01, text: labels[0][1] },
      { x: "台語懸", y: "華語低", z: z10, text: labels[1][0] },
      { x: "台語低", y: "華語低", z: z11, text: labels[1][1] },
    ];
    return specs.map(function (s) {
      return {
        xref: "x",
        yref: "y",
        x: s.x,
        y: s.y,
        text: s.text,
        showarrow: false,
        xanchor: "center",
        yanchor: "middle",
        font: { size: 13, color: pickHeatmapLabelColor(colorForZ(s.z)) },
      };
    });
  }

  function plotFreqHeatmap2x2(
    elId,
    cellStats,
    title,
    colorScale,
    valueForAccAsPercent,
  ) {
    const el = document.getElementById(elId);
    if (!el) return;
    const finite =
      cellStats &&
      ["A", "B", "C", "D"].every(
        (L) => cellStats[L] && Number.isFinite(cellStats[L].m),
      );
    if (!finite) {
      Plotly.react(
        el,
        [],
        {
          ...plotlyLayoutBase,
          title: { text: title + "（無足夠資料）" },
          annotations: [
            {
              text: "無可繪製之跨人平均",
              xref: "paper",
              yref: "paper",
              x: 0.5,
              y: 0.5,
              showarrow: false,
              font: { size: 13, color: "#5d6d7e" },
            },
          ],
        },
        { responsive: true },
      );
      return;
    }
    let z00 = cellStats.A.m;
    let z01 = cellStats.B.m;
    let z10 = cellStats.C.m;
    let z11 = cellStats.D.m;
    let text = [
      [fmtNum(z00, 0), fmtNum(z01, 0)],
      [fmtNum(z10, 0), fmtNum(z11, 0)],
    ];
    if (valueForAccAsPercent) {
      z00 *= 100;
      z01 *= 100;
      z10 *= 100;
      z11 *= 100;
      text = [
        [fmtNum(z00, 1) + "%", fmtNum(z01, 1) + "%"],
        [fmtNum(z10, 1) + "%", fmtNum(z11, 1) + "%"],
      ];
    }
    const annos = heatmapCellLabelAnnotations(
      z00,
      z01,
      z10,
      z11,
      text,
      colorScale,
    );
    Plotly.react(
      el,
      [
        {
          type: "heatmap",
          z: [
            [z00, z01],
            [z10, z11],
          ],
          x: ["台語懸", "台語低"],
          y: ["華語懸", "華語低"],
          colorscale: colorScale,
          hovertemplate:
            "華語 %{y}<br>台語 %{x}<br>" +
            (valueForAccAsPercent ? "%{z:.1f}%<extra></extra>" : "%{z:.0f} ms<extra></extra>"),
          colorbar: {
            title:
              valueForAccAsPercent
                ? { text: "正確率（%）", side: "right" }
                : { text: "RT（ms）", side: "right" },
          },
        },
      ],
      {
        ...plotlyLayoutBase,
        title: { text: title },
        xaxis: { title: "台語詞頻分組" },
        yaxis: { title: "華語詞頻分組", autorange: "reversed" },
        margin: { ...plotlyLayoutBase.margin, l: 72 },
        annotations: annos,
      },
      { responsive: true },
    );
  }

  function renderFreqRmSection(completedFiles) {
    const metaEl = document.getElementById("freq-rm-meta");
    const tableEl = document.getElementById("freq-rm-anova-table");
    const rows = buildParticipantAbcdCells(completedFiles);
    const rtRes = rm2x2Contrasts(rows, "rt");
    const accRes = rm2x2Contrasts(rows, "acc");
    const rtCells = cellMeansAndSem(rows, "rt");
    const accCells = cellMeansAndSem(rows, "acc");

    if (metaEl) {
      metaEl.textContent =
        "台華共同詞 A–D：完成實驗受試者共 " +
        rows.length +
        " 人；RT 分析完整資料 n = " +
        rtRes.rowsUsed +
        "（四格皆有可計算之正確 RT）；正確率分析完整資料 n = " +
        accRes.rowsUsed +
        "。各列 t 檢定對應雙因子受試者內變異數分析中同來源之 F(1, n−1) = t²。";
    }
    renderFreqRmAnovaTable(tableEl, rtRes, accRes);

    plotFreqInteractionLines(
      "chart-freq-rt-interaction",
      rtCells,
      "交互作用圖：平均 RT（受試者內細格平均 → 跨人平均 ± SEM）",
      "RT（ms）",
      false,
    );
    plotFreqInteractionLines(
      "chart-freq-acc-interaction",
      accCells,
      "交互作用圖：平均正確率（同上）",
      "正確率（%）",
      true,
    );
    plotFreqHeatmap2x2(
      "chart-freq-rt-heatmap",
      rtCells,
      "2×2 細格：跨人平均 RT（ms）",
      [
        [0, "#ebf5fb"],
        [0.5, "#5dade2"],
        [1, "#1a5276"],
      ],
      false,
    );
    plotFreqHeatmap2x2(
      "chart-freq-acc-heatmap",
      accCells,
      "2×2 細格：跨人平均正確率（%）",
      [
        [0, "#eafaf1"],
        [0.5, "#52be80"],
        [1, "#145a32"],
      ],
      true,
    );

    const smeIntro = document.getElementById("freq-rm-sme-intro");
    const smeTable = document.getElementById("freq-rm-simple-effects-table");
    if (smeIntro) {
      smeIntro.textContent = freqRmSmeIntroText(rtRes, accRes, 0.05);
    }
    const rtSme = rm2x2SimpleMainEffects(rows, "rt");
    const accSme = rm2x2SimpleMainEffects(rows, "acc");
    renderFreqRmSimpleEffectsTable(smeTable, rtSme, accSme);
  }

  function abGroupsInItemMap(itemMap) {
    const present = new Set();
    itemMap.forEach((rec) => present.add(rec.ab組 || AB_GROUP_OTHER));
    const ordered = [];
    for (let i = 0; i < AB_GROUP_ORDER.length; i++) {
      if (present.has(AB_GROUP_ORDER[i])) ordered.push(AB_GROUP_ORDER[i]);
    }
    const rest = Array.from(present).filter(
      (k) => AB_GROUP_ORDER.indexOf(k) === -1,
    );
    rest.sort();
    return ordered.concat(rest);
  }

  /** 字卡右上角：isword 1 真詞／0 假詞；無欄位則不顯示徽章 */
  function stimWordTypeBadge(isword) {
    const s = String(isword).trim();
    if (s === "1") return { text: "真詞", cls: "stim-badge stim-badge--real" };
    if (s === "0")
      return { text: "假詞", cls: "stim-badge stim-badge--pseudo" };
    return null;
  }

  /** 詞頻標籤底色依「懸／低」區分；其餘值用中性樣式 */
  function stimFreqTagClass(freqVal) {
    const f = trimStr(freqVal);
    if (f === "懸") return "stim-tag stim-tag--freq-xuan";
    if (f === "低") return "stim-tag stim-tag--freq-di";
    return "stim-tag stim-tag--freq-other";
  }

  function browseSortedItemsForLetter(itemMap, letter) {
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
    return items;
  }

  /** 該組共通的真／假詞與詞頻（顯示於選單上方） */
  function renderBrowseGroupSummary(host, items) {
    if (!host) return;
    host.innerHTML = "";
    if (!items.length) {
      host.style.display = "none";
      return;
    }
    const isSet = new Set();
    const twSet = new Set();
    const huaSet = new Set();
    for (let i = 0; i < items.length; i++) {
      const r = items[i];
      const iw = String(r.isword).trim();
      if (iw !== "") isSet.add(iw);
      const t = trimStr(r.台語詞頻分組);
      const h = trimStr(r.華語詞頻分組);
      if (t) twSet.add(t);
      if (h) huaSet.add(h);
    }
    const bar = document.createElement("div");
    bar.className = "browse-group-summary";
    const isArr = Array.from(isSet).sort();
    for (let j = 0; j < isArr.length; j++) {
      const b = stimWordTypeBadge(isArr[j]);
      if (b) {
        const span = document.createElement("span");
        span.className = b.cls;
        span.textContent = b.text;
        bar.appendChild(span);
      }
    }
    if (isArr.length > 1) {
      const w = document.createElement("span");
      w.className = "browse-group-summary-warn";
      w.textContent = "（組內 isword 不一致）";
      bar.appendChild(w);
    }
    const twArr = Array.from(twSet).sort((a, b) => a.localeCompare(b, "zh-Hant"));
    const huaArr = Array.from(huaSet).sort((a, b) =>
      a.localeCompare(b, "zh-Hant"),
    );
    for (let j = 0; j < twArr.length; j++) {
      const sp = document.createElement("span");
      sp.className = stimFreqTagClass(twArr[j]);
      sp.textContent = "台語詞頻：" + twArr[j];
      bar.appendChild(sp);
    }
    for (let j = 0; j < huaArr.length; j++) {
      const sp = document.createElement("span");
      sp.className = stimFreqTagClass(huaArr[j]);
      sp.textContent = "華語詞頻：" + huaArr[j];
      bar.appendChild(sp);
    }
    if (!bar.firstChild) {
      host.style.display = "none";
      return;
    }
    host.appendChild(bar);
    host.style.display = "";
  }

  function renderBrowseAbCards(host, items) {
    if (!host) return;
    host.innerHTML = "";
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
      const card = document.createElement("article");
      card.className = "stim-card";
      if (han) {
        const el = document.createElement("div");
        el.className = "stim-han";
        el.textContent = han;
        card.appendChild(el);
      }
      if (tl) {
        const el = document.createElement("div");
        el.className = "stim-tl";
        el.textContent = tl;
        card.appendChild(el);
      }
      if (!card.firstChild) continue;
      grid.appendChild(card);
    }
    if (!grid.children.length) {
      const p = document.createElement("p");
      p.className = "subtext";
      p.textContent = "此組題目在資料中尚無漢字或臺羅可顯示。";
      host.appendChild(p);
      return;
    }
    host.appendChild(grid);
  }

  function refreshBrowseStimuli(summaryHost, cardsHost, itemMap, letter) {
    const items = browseSortedItemsForLetter(itemMap, letter);
    if (summaryHost) renderBrowseGroupSummary(summaryHost, items);
    if (cardsHost) renderBrowseAbCards(cardsHost, items);
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
    if (cur && Array.prototype.some.call(sel.options, (op) => op.value === cur))
      sel.value = cur;
  }

  function fmtNum(x, digits) {
    if (!Number.isFinite(x)) return "—";
    return x.toFixed(digits);
  }

  function pctClamp01(x) {
    if (!Number.isFinite(x)) return 0;
    return Math.max(0, Math.min(100, x));
  }

  function countCorrOnes(corrs) {
    let c = 0;
    if (!corrs || !corrs.length) return 0;
    for (let j = 0; j < corrs.length; j++) {
      if (corrs[j] === 1) c++;
    }
    return c;
  }

  function collectItemRowsByAb(itemMap, abFilter) {
    const rows = [];
    itemMap.forEach((rec) => {
      if (abFilter && rec.ab組 !== abFilter) return;
      rows.push(rec);
    });
    return rows;
  }

  function sortItemRowsForDisplay(rows, sortMode) {
    const sorted = rows.slice();
    sorted.sort((a, b) => {
      const sa = itemRowStats(a);
      const sb = itemRowStats(b);
      if (sortMode === "acc") {
        const cmp = (sb.acc || 0) - (sa.acc || 0);
        if (cmp !== 0) return cmp;
      } else {
        const raRt = Number.isFinite(sa.mCor) ? sa.mCor : sa.mAll;
        const rbRt = Number.isFinite(sb.mCor) ? sb.mCor : sb.mAll;
        const ra = Number.isFinite(raRt) ? raRt : Infinity;
        const rb = Number.isFinite(rbRt) ? rbRt : Infinity;
        if (ra !== rb) return ra - rb;
      }
      const ka = String(a.ifile || a.漢字 || a.臺羅 || "");
      const kb = String(b.ifile || b.漢字 || b.臺羅 || "");
      return ka.localeCompare(kb, "zh-Hant");
    });
    return sorted;
  }

  function sdForRtDisplay(rec, st) {
    if (Number.isFinite(st.mCor)) {
      if (rec.rtsCorrect.length >= 2 && Number.isFinite(st.sdCor))
        return st.sdCor;
      return NaN;
    }
    if (rec.rts.length >= 2 && Number.isFinite(st.sdAll)) return st.sdAll;
    return NaN;
  }

  /** 逐題字卡：華／台詞頻分組佮真／假詞（與題目瀏覽區相同之標籤樣式） */
  function appendItemStatStimMeta(card, rec) {
    const hua = trimStr(rec.華語詞頻分組);
    const tw = trimStr(rec.台語詞頻分組);
    const bar = document.createElement("div");
    bar.className = "item-stat-stim-meta browse-group-summary";
    const huaSp = document.createElement("span");
    huaSp.className = stimFreqTagClass(hua || "—");
    huaSp.textContent = "華語詞頻：" + (hua || "—");
    bar.appendChild(huaSp);
    const twSp = document.createElement("span");
    twSp.className = stimFreqTagClass(tw || "—");
    twSp.textContent = "台語詞頻：" + (tw || "—");
    bar.appendChild(twSp);
    const badge = stimWordTypeBadge(rec.isword);
    if (badge) {
      const bEl = document.createElement("span");
      bEl.className = badge.cls;
      bEl.textContent = "真詞／假詞：" + badge.text;
      bar.appendChild(bEl);
    } else {
      const unk = document.createElement("span");
      unk.className = "stim-tag stim-tag--freq-other";
      unk.textContent = "真詞／假詞：—";
      bar.appendChild(unk);
    }
    card.appendChild(bar);
  }

  /**
   * 依呈現順序（thisIndex，無則陣列序）走訪試次，分到 A–F；（其他）另列，排版時接在 F
   * 試次之後、仍填於第 6–10 欄。
   */
  function partitionTrialsByAbPresentationOrder(trials) {
    const annotated = [];
    for (let i = 0; i < trials.length; i++) {
      annotated.push({ t: trials[i], ord: i });
    }
    annotated.sort((a, b) => {
      const ia = parseNum(a.t.thisIndex);
      const ib = parseNum(b.t.thisIndex);
      const fa = Number.isFinite(ia) ? ia : a.ord;
      const fb = Number.isFinite(ib) ? ib : b.ord;
      return fa - fb;
    });
    const buckets = { A: [], B: [], C: [], D: [], E: [], F: [] };
    const other = [];
    for (let j = 0; j < annotated.length; j++) {
      const t = annotated[j].t;
      const g = t.ab組;
      if (buckets[g]) buckets[g].push(t);
      else other.push(t);
    }
    return { buckets, other };
  }

  function trialDisplayWord(t) {
    const han = trimStr(t.漢字);
    if (han) return han;
    const tl = trimStr(t.臺羅);
    if (tl) return tl;
    return "—";
  }

  function appendSubjectTrialGridCell(grid, t, rtCap) {
    const cell = document.createElement("div");
    cell.className = "subject-trial-cell";
    if (!t) {
      cell.classList.add("subject-trial-cell--empty");
      const w = document.createElement("div");
      w.className = "subject-trial-word";
      w.textContent = "—";
      cell.appendChild(w);
      grid.appendChild(cell);
      return;
    }
    const ok = t.corr === 1;
    cell.classList.add(ok ? "subject-trial-cell--ok" : "subject-trial-cell--bad");
    const ab = trimStr(t.ab組) || "—";
    const rt = Number.isFinite(t.rtMs) ? t.rtMs : NO_RESPONSE_RT_MS;
    cell.title =
      ab +
      " 組 · RT " +
      Math.round(rt) +
      " ms · " +
      (ok ? "正確" : "錯誤") +
      (t.imputed ? "（補齊列）" : "");

    const word = document.createElement("div");
    word.className = "subject-trial-word";
    word.textContent = trialDisplayWord(t);
    cell.appendChild(word);

    const track = document.createElement("div");
    track.className = "subject-trial-rt-track";
    const fill = document.createElement("div");
    fill.className =
      "subject-trial-rt-fill " +
      (ok ? "subject-trial-rt-fill--ok" : "subject-trial-rt-fill--bad");
    const pct = rtCap > 0 ? Math.min(100, (rt / rtCap) * 100) : 0;
    fill.style.width = pctClamp01(pct) + "%";
    track.appendChild(fill);
    cell.appendChild(track);

    grid.appendChild(cell);
  }

  function renderSubjectTrialGrid(host, file) {
    if (!host) return;
    host.innerHTML = "";
    if (!file || !file.trials || !file.trials.length) {
      const p = document.createElement("p");
      p.className = "subtext";
      p.textContent = "無試次可顯示。";
      host.appendChild(p);
      return;
    }
    const { buckets, other } = partitionTrialsByAbPresentationOrder(
      file.trials,
    );
    const fSequence = buckets.F.concat(other);
    const hA = buckets.A.length;
    const hB = buckets.B.length;
    const hC = buckets.C.length;
    const hD = buckets.D.length;
    const hE = buckets.E.length;
    const fRows = fSequence.length ? Math.ceil(fSequence.length / 5) : 0;
    const R = Math.max(hA, hB, hC, hD, hE, fRows);

    const wrap = document.createElement("div");
    wrap.className = "subject-trial-grid-wrap";

    const headers = document.createElement("div");
    headers.className = "subject-trial-col-headers";
    const labels = ["A", "B", "C", "D", "E"];
    for (let hi = 0; hi < labels.length; hi++) {
      const g = labels[hi];
      const el = document.createElement("div");
      el.className = "subject-trial-col-head";
      el.textContent = g + " 組";
      if (AB_GROUP_DESC[g]) {
        const tip = g + " 組：" + AB_GROUP_DESC[g];
        el.setAttribute("data-tip", tip);
        el.title = tip;
      }
      headers.appendChild(el);
    }
    const hF = document.createElement("div");
    hF.className = "subject-trial-col-head subject-trial-col-head--f";
    hF.textContent = "F 組";
    const fTip =
      "F 組：" +
      (AB_GROUP_DESC.F || "假詞。") +
      "（此區後段可能接續顯示無法歸入 A–F 之試次）";
    hF.setAttribute("data-tip", fTip);
    hF.title = fTip;
    headers.appendChild(hF);

    const grid = document.createElement("div");
    grid.className = "subject-trial-grid subject-trial-grid--cols";
    grid.style.gridTemplateRows = "repeat(" + R + ", minmax(48px, auto))";

    const rtCap = NO_RESPONSE_RT_MS;
    for (let r = 0; r < R; r++) {
      appendSubjectTrialGridCell(grid, r < hA ? buckets.A[r] : null, rtCap);
      appendSubjectTrialGridCell(grid, r < hB ? buckets.B[r] : null, rtCap);
      appendSubjectTrialGridCell(grid, r < hC ? buckets.C[r] : null, rtCap);
      appendSubjectTrialGridCell(grid, r < hD ? buckets.D[r] : null, rtCap);
      appendSubjectTrialGridCell(grid, r < hE ? buckets.E[r] : null, rtCap);
      for (let k = 0; k < 5; k++) {
        const idx = r * 5 + k;
        appendSubjectTrialGridCell(
          grid,
          idx < fSequence.length ? fSequence[idx] : null,
          rtCap,
        );
      }
    }

    wrap.appendChild(headers);
    wrap.appendChild(grid);
    host.appendChild(wrap);
  }

  function computeRtBarScaleMs(sortedRows) {
    let rtMax = 0;
    for (let i = 0; i < sortedRows.length; i++) {
      const rec = sortedRows[i];
      const st = itemRowStats(rec);
      const m = Number.isFinite(st.mCor) ? st.mCor : st.mAll;
      const sd = sdForRtDisplay(rec, st);
      const hi =
        Number.isFinite(m) && Number.isFinite(sd) ? m + sd : m;
      if (Number.isFinite(hi) && hi > rtMax) rtMax = hi;
    }
    if (!Number.isFinite(rtMax) || rtMax < 400) rtMax = 800;
    if (rtMax > 6000) rtMax = 6000;
    return rtMax;
  }

  function appendBarRowMetric(
    card,
    label,
    sdBandLeftPct,
    sdBandWidthPct,
    fillPct,
    fillMod,
    valueLine,
    sdLine,
  ) {
    const block = document.createElement("div");
    block.className = "item-metric";
    const hd = document.createElement("div");
    hd.className = "item-metric-hd";
    const lab = document.createElement("span");
    lab.className = "item-metric-label";
    lab.textContent = label;
    hd.appendChild(lab);
    const val = document.createElement("span");
    val.className = "item-metric-val";
    val.textContent = valueLine;
    hd.appendChild(val);
    if (sdLine != null && sdLine !== "") {
      const sdEl = document.createElement("span");
      sdEl.className = "item-metric-sd";
      sdEl.textContent = sdLine;
      hd.appendChild(sdEl);
    }
    block.appendChild(hd);

    const row = document.createElement("div");
    row.className = "item-bar-row";
    const track = document.createElement("div");
    track.className = "item-bar-track";
    if (
      Number.isFinite(sdBandWidthPct) &&
      sdBandWidthPct > 0 &&
      Number.isFinite(sdBandLeftPct)
    ) {
      const band = document.createElement("div");
      band.className = "item-bar-sd-band";
      band.style.left = pctClamp01(sdBandLeftPct) + "%";
      band.style.width = pctClamp01(sdBandWidthPct) + "%";
      track.appendChild(band);
    }
    const fill = document.createElement("div");
    fill.className = "item-bar-fill " + fillMod;
    fill.style.width = pctClamp01(fillPct) + "%";
    track.appendChild(fill);
    row.appendChild(track);
    block.appendChild(row);
    card.appendChild(block);
  }

  function renderItemCards(host, itemMap, abFilter, sortMode) {
    if (!host) return;
    host.innerHTML = "";
    const rows = collectItemRowsByAb(itemMap, abFilter);
    const sorted = sortItemRowsForDisplay(rows, sortMode || "rt");
    const rtMax = computeRtBarScaleMs(sorted);

    if (!sorted.length) {
      const p = document.createElement("p");
      p.className = "subtext";
      p.textContent = "無符合條件的題目。";
      host.appendChild(p);
      return;
    }

    const grid = document.createElement("div");
    grid.className = "item-stat-grid";
    for (let i = 0; i < sorted.length; i++) {
      const rec = sorted[i];
      const st = itemRowStats(rec);
      const card = document.createElement("article");
      card.className = "item-stat-card";

      const head = document.createElement("div");
      head.className = "item-stat-card-head";
      const ab = document.createElement("span");
      ab.className = "item-stat-ab";
      ab.textContent = rec.ab組 || "—";
      head.appendChild(ab);
      const titles = document.createElement("div");
      titles.className = "item-stat-titles";
      const han = trimStr(rec.漢字);
      const tl = trimStr(rec.臺羅);
      if (han) {
        const h = document.createElement("div");
        h.className = "stim-han";
        h.textContent = han;
        titles.appendChild(h);
      }
      if (tl) {
        const t = document.createElement("div");
        t.className = "stim-tl";
        t.textContent = tl;
        titles.appendChild(t);
      }
      head.appendChild(titles);
      card.appendChild(head);
      appendItemStatStimMeta(card, rec);

      const ifile = trimStr(rec.ifile);
      if (ifile) {
        const meta = document.createElement("div");
        meta.className = "item-stat-ifile";
        meta.textContent = ifile;
        card.appendChild(meta);
      }
      const nEl = document.createElement("div");
      nEl.className = "item-stat-n";
      nEl.textContent = "n = " + String(st.n);
      card.appendChild(nEl);
      const nOk = countCorrOnes(rec.corrs);
      const nBad = Math.max(0, rec.corrs.length - nOk);
      const nDetail = document.createElement("div");
      nDetail.className = "item-stat-n-detail";
      nDetail.textContent = "正確 " + String(nOk) + " · 錯誤 " + String(nBad);
      card.appendChild(nDetail);

      const accMean = st.acc;
      const accMeanPct = Number.isFinite(accMean) ? accMean * 100 : 0;
      const accVal =
        (Number.isFinite(accMean) ? fmtNum(accMean * 100, 1) : "—") + "%";
      appendBarRowMetric(
        card,
        "正確率",
        NaN,
        NaN,
        accMeanPct,
        "item-bar-fill--acc",
        accVal,
        "",
      );

      const mRt = Number.isFinite(st.mCor) ? st.mCor : st.mAll;
      const sdRt = sdForRtDisplay(rec, st);
      const rtLabel = Number.isFinite(st.mCor) ? "平均 RT（僅正確）" : "平均 RT（全部）";
      const mPct = Number.isFinite(mRt) && rtMax > 0 ? (mRt / rtMax) * 100 : 0;
      const sdHalfPct =
        Number.isFinite(sdRt) && Number.isFinite(mRt) && rtMax > 0
          ? (sdRt / rtMax) * 100
          : 0;
      const rtSdLeftRaw = mPct - sdHalfPct;
      const rtSdRightRaw = mPct + sdHalfPct;
      const rtSdLeft = pctClamp01(rtSdLeftRaw);
      const rtSdRight = pctClamp01(rtSdRightRaw);
      const rtSdW = Math.max(0, rtSdRight - rtSdLeft);
      const rtVal =
        (Number.isFinite(mRt) ? fmtNum(mRt, 0) : "—") + " ms";
      const rtSdTxt = Number.isFinite(sdRt) ? "SD " + fmtNum(sdRt, 0) + " ms" : "SD —";
      appendBarRowMetric(
        card,
        rtLabel,
        rtSdLeft,
        rtSdW,
        mPct,
        "item-bar-fill--rt",
        rtVal,
        rtSdTxt,
      );

      grid.appendChild(card);
    }
    host.appendChild(grid);
  }

  function renderQualityTables(host, q, certUnmappedLines, excludedAllWrongLines) {
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
        li.textContent =
          typeof items[i] === "string"
            ? items[i]
            : items[i].file + " — " + items[i].msg;
        ul.appendChild(li);
      }
      wrap.appendChild(ul);
      host.appendChild(wrap);
    }

    block("載入或解析失敗", q.loadErrors);
    block("未完成實驗（未納入統計）", q.incomplete, "warn-list");
    block("已完成但試次數異常", q.badTrialCount, "warn-list");
    block(
      "全錯誤排除（正式試次無任一筆正確，不納入回答分析）",
      excludedAllWrongLines || [],
      "warn-list",
    );
    if (certUnmappedLines && certUnmappedLines.length) {
      block(
        "台語檢定成績：尚無標準化規則之原始填答（圖表暫歸「（待標準化）」；可於 ldt-report.js 的 normalizeCert 增列對應）",
        certUnmappedLines,
        "warn-list",
      );
    }
    block("其他提示", q.other);
  }

  async function run() {
    const statusEl = document.getElementById("load-status");
    const cardsEl = document.getElementById("stat-cards");
    const qualityHost = document.getElementById("quality-detail");
    const itemCardsHost = document.getElementById("item-cards-host");
    const selItemSort = document.getElementById("filter-item-sort");

    const files = [];

    let usedBundle = false;
    try {
      const resDs = await fetch(DATASET_URL);
      if (resDs.ok) {
        const bundle = await resDs.json();
        if (
          bundle &&
          bundle.format === "ldt-report-bundle" &&
          Array.isArray(bundle.files)
        ) {
          usedBundle = true;
          statusEl.textContent = "載入合併資料集…";
          const entries = bundle.files;
          for (let i = 0; i < entries.length; i++) {
            const ent = entries[i];
            const p = ent && ent.sourcePath != null ? String(ent.sourcePath) : "";
            const rows = ent && ent.rows;
            if (!Array.isArray(rows)) {
              files.push({
                fileName: p.split("/").pop() || p || "（未知）",
                sourcePath: p,
                ok: false,
                error: "合併資料集項目缺少 rows 陣列",
                complete: false,
                participant: "",
                demo: null,
                formalCount: 0,
                trials: [],
                quality: ["合併資料集格式錯誤"],
              });
              continue;
            }
            files.push(finalizeFromRows(rows, p, []));
          }
        }
      }
    } catch (e) {
      usedBundle = false;
    }

    if (!usedBundle) {
      statusEl.textContent = "載入清單…";

      let manifest;
      try {
        const res = await fetch(MANIFEST_URL, { cache: "no-store" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        manifest = await res.json();
      } catch (e) {
        statusEl.textContent =
          "無法載入 data-manifest.json：" + (e && e.message ? e.message : e);
        return;
      }

      const paths = Array.isArray(manifest.files) ? manifest.files : [];
      statusEl.textContent = "讀取 " + paths.length + " 個 CSV…";

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
    }

    const completed = files.filter(
      (f) => f.ok && f.complete && f.trials.length === EXPECTED_TRIALS,
    );
    const manualExcludedSet = loadManualExcludedSet();
    const completedManuallyExcluded = completed.filter((f) =>
      manualExcludedSet.has(subjectIdentityKey(f)),
    );
    const excludedAllWrong = completed.filter((f) => fileAllTrialsIncorrect(f));
    const excludedAllWrongKeySet = new Set(
      excludedAllWrong.map((f) => subjectIdentityKey(f)),
    );
    const completedAnalyzed = completed.filter(
      (f) =>
        !fileAllTrialsIncorrect(f) &&
        !manualExcludedSet.has(subjectIdentityKey(f)),
    );
    const excludedAllWrongLines = excludedAllWrong.map(
      (f) =>
        f.fileName +
        "（participant " +
        (trimStr(f.participant) || "—") +
        "：正式試次無任一筆正確，已自回答分析排除）",
    );
    const excludedManualLines = completedManuallyExcluded.map((f) => {
      const pid = trimStr(f.participant) || "—";
      return (
        f.fileName +
        "（participant " +
        pid +
        "：已手動勾選排除，暫不納入整體統計）"
      );
    });
    const q = mergeQuality(files);

    const ages = [];
    const genders = [];
    const certs = [];
    const certUnmappedLines = [];
    for (let i = 0; i < completedAnalyzed.length; i++) {
      const d = completedAnalyzed[i].demo;
      if (!d) continue;
      const age = parseNum(d["年齡"]);
      if (Number.isFinite(age)) ages.push(age);
      genders.push(normalizeGender(d["性別"]));
      const certNorm = normalizeCert(d["台語檢定成績"]);
      certs.push(certNorm.level);
      if (certNorm.unmappedRaw != null) {
        certUnmappedLines.push(
          completedAnalyzed[i].fileName +
            "：原始填答「" +
            certNorm.unmappedRaw +
            "」尚無標準化規則，圖表暫歸「（待標準化）」",
        );
      }
    }

    const genderLabels = ["男", "女", "其他", "未知"];
    const genderCounts = genderLabels.map(
      (g) => genders.filter((x) => x === g).length,
    );
    const uniqCert = Array.from(new Set(certs)).sort(
      (a, b) => certSortKey(a) - certSortKey(b),
    );
    const certCounts = uniqCert.map(
      (lab) => certs.filter((c) => c === lab).length,
    );

    const totalTrials = completedAnalyzed.reduce(
      (s, f) => s + f.trials.length,
      0,
    );

    renderStatCards(cardsEl, {
      manifestCount: files.length,
      loadedOk: files.filter((f) => f.ok).length,
      completedEighty: completed.length,
      inAnalysis: completedAnalyzed.length,
      incomplete: files.filter((f) => f.ok && !f.complete).length,
      totalTrials,
    });

    plotHistogram("chart-age", ages, "年齡分布（納入分析者）");
    plotBarCounts(
      "chart-gender",
      genderLabels,
      genderCounts,
      "性別分布（納入分析者；正規化後）",
      "類別",
    );
    plotBarCounts(
      "chart-cert",
      uniqCert,
      certCounts,
      "台語檢定最高等級（納入分析者；標準化：未考取／A1–C2）",
      "等級",
    );

    const grp = aggregateByAbGroup(completedAnalyzed);
    plotGroupRt("chart-by-group-rt", grp.labels, grp.meanRtCorr);
    plotGroupAcc("chart-by-group-acc", grp.labels, grp.meanAcc);

    renderFreqRmSection(completedAnalyzed);

    const itemMap = buildItemMap(completedAnalyzed);
    const allAb = abGroupsInItemMap(itemMap);

    const selAb = document.getElementById("filter-ab組");
    const browseSel = document.getElementById("browse-ab-select");
    const browseHost = document.getElementById("browse-ab-cards-host");
    const browseSummaryHost = document.getElementById(
      "browse-group-summary-host",
    );
    const browseNavRow = document.getElementById("browse-nav-row");
    const browsePrev = document.getElementById("browse-ab-prev");
    const browseNext = document.getElementById("browse-ab-next");

    if (selAb) fillSelect(selAb, allAb, true);

    if (browseSel && browseHost) {
      function syncBrowseNavButtons() {
        if (!browseSel || !browsePrev || !browseNext) return;
        let n = 0;
        for (let i = 0; i < browseSel.options.length; i++) {
          if (browseSel.options[i].value !== "") n++;
        }
        const dis = n <= 1;
        browsePrev.disabled = dis;
        browseNext.disabled = dis;
      }
      function moveBrowseGroup(delta) {
        if (!browseSel) return;
        const vals = [];
        for (let i = 0; i < browseSel.options.length; i++) {
          const v = browseSel.options[i].value;
          if (v !== "") vals.push(v);
        }
        if (!vals.length) return;
        let idx = vals.indexOf(browseSel.value);
        if (idx < 0) idx = 0;
        idx = (idx + delta + vals.length) % vals.length;
        browseSel.value = vals[idx];
        refreshBrowseStimuli(
          browseSummaryHost,
          browseHost,
          itemMap,
          browseSel.value,
        );
        syncBrowseNavButtons();
      }

      browseSel.innerHTML = "";
      if (!allAb.length) {
        if (browseNavRow) browseNavRow.style.display = "none";
        if (browsePrev) browsePrev.onclick = null;
        if (browseNext) browseNext.onclick = null;
        const o = document.createElement("option");
        o.value = "";
        o.textContent = "（無完成資料之題目）";
        browseSel.appendChild(o);
        browseHost.innerHTML = "";
        if (browseSummaryHost) {
          browseSummaryHost.innerHTML = "";
          browseSummaryHost.style.display = "none";
        }
        const p = document.createElement("p");
        p.className = "subtext";
        p.textContent = "尚無已完成實驗之 CSV，無法列出題目。";
        browseHost.appendChild(p);
      } else {
        if (browseNavRow) browseNavRow.style.display = "flex";
        for (let i = 0; i < allAb.length; i++) {
          const lab = allAb[i];
          const o = document.createElement("option");
          o.value = lab;
          o.textContent = lab + " 組";
          browseSel.appendChild(o);
        }
        browseSel.value = allAb[0];
        refreshBrowseStimuli(
          browseSummaryHost,
          browseHost,
          itemMap,
          browseSel.value,
        );
        syncBrowseNavButtons();
        browseSel.onchange = function () {
          refreshBrowseStimuli(
            browseSummaryHost,
            browseHost,
            itemMap,
            browseSel.value,
          );
          syncBrowseNavButtons();
        };
        if (browsePrev) browsePrev.onclick = () => moveBrowseGroup(-1);
        if (browseNext) browseNext.onclick = () => moveBrowseGroup(1);
      }
    }

    function applyItemCards() {
      if (!itemCardsHost) return;
      const ab = selAb ? selAb.value : "";
      const sortMode =
        selItemSort && selItemSort.value === "acc" ? "acc" : "rt";
      renderItemCards(itemCardsHost, itemMap, ab, sortMode);
    }

    if (selAb) selAb.onchange = applyItemCards;
    if (selItemSort) selItemSort.onchange = applyItemCards;

    applyItemCards();

    const subjToolbar = document.getElementById("subject-trial-toolbar");
    const subjPrev = document.getElementById("subject-trial-prev");
    const subjNext = document.getElementById("subject-trial-next");
    const subjRandom = document.getElementById("subject-trial-random");
    const subjLabel = document.getElementById("subject-trial-label");
    const subjDemo = document.getElementById("subject-trial-demo");
    const subjGridHost = document.getElementById("subject-trial-grid-host");
    const subjExclude = document.getElementById("subject-trial-exclude");
    const completedSorted = completedAnalyzed
      .slice()
      .sort((a, b) =>
        String(a.fileName).localeCompare(String(b.fileName), "zh-Hant"),
      );
    const subjectBrowseSorted = completed
      .slice()
      .sort((a, b) =>
        String(a.fileName).localeCompare(String(b.fileName), "zh-Hant"),
      );
    const subjState = { idx: 0 };

    const savedSubjectKey = trimStr(safeLocalStorageGet(SUBJECT_PICK_STORAGE_KEY));
    if (savedSubjectKey) {
      const savedIdx = subjectBrowseSorted.findIndex(
        (f) => subjectIdentityKey(f) === savedSubjectKey,
      );
      if (savedIdx >= 0) subjState.idx = savedIdx;
    }

    function subjectTrialLabelText(f, idx, total) {
      const pid = trimStr(f.participant) || "（無編號）";
      return (
        "受試者 " +
        (idx + 1) +
        " / " +
        total +
        "：" +
        pid +
        " · " +
        f.fileName
      );
    }

    function refreshSubjectTrialView() {
      if (!subjGridHost) return;
      const n = subjectBrowseSorted.length;
      if (!n) {
        if (subjToolbar) subjToolbar.style.display = "none";
        if (subjDemo) subjDemo.textContent = "";
        if (subjExclude) {
          subjExclude.checked = false;
          subjExclude.disabled = true;
        }
        subjGridHost.innerHTML = "";
        const p = document.createElement("p");
        p.className = "subtext";
        p.textContent = "尚無已完成實驗之資料，無法顯示單人作答總覽。";
        subjGridHost.appendChild(p);
        return;
      }
      if (subjToolbar) subjToolbar.style.display = "flex";
      subjState.idx = Math.max(0, Math.min(subjState.idx, n - 1));
      const f = subjectBrowseSorted[subjState.idx];
      const subjKey = subjectIdentityKey(f);
      const autoExcludedByAllWrong = excludedAllWrongKeySet.has(subjKey);
      safeLocalStorageSet(SUBJECT_PICK_STORAGE_KEY, subjKey);
      if (subjLabel) subjLabel.textContent = subjectTrialLabelText(f, subjState.idx, n);
      if (subjDemo) subjDemo.textContent = subjectTrialDemoSummary(f);
      if (subjExclude) {
        subjExclude.checked = autoExcludedByAllWrong || manualExcludedSet.has(subjKey);
        subjExclude.disabled = autoExcludedByAllWrong;
        subjExclude.title = autoExcludedByAllWrong
          ? "此受試者因全錯誤已自動排除"
          : "";
      }
      const dis = n <= 1;
      if (subjPrev) subjPrev.disabled = dis;
      if (subjNext) subjNext.disabled = dis;
      if (subjRandom) subjRandom.disabled = dis;
      renderSubjectTrialGrid(subjGridHost, f);
    }

    if (subjPrev)
      subjPrev.onclick = function () {
        const n = subjectBrowseSorted.length;
        if (n) subjState.idx = (subjState.idx - 1 + n) % n;
        refreshSubjectTrialView();
      };
    if (subjNext)
      subjNext.onclick = function () {
        const n = subjectBrowseSorted.length;
        if (n) subjState.idx = (subjState.idx + 1) % n;
        refreshSubjectTrialView();
      };
    if (subjRandom)
      subjRandom.onclick = function () {
        const n = subjectBrowseSorted.length;
        if (n < 2) return;
        let r = subjState.idx;
        for (let k = 0; k < 12; k++) {
          r = Math.floor(Math.random() * n);
          if (r !== subjState.idx) break;
        }
        subjState.idx = r;
        refreshSubjectTrialView();
      };
    if (subjExclude)
      subjExclude.onchange = function () {
        const n = subjectBrowseSorted.length;
        if (!n) return;
        const f = subjectBrowseSorted[subjState.idx];
        const key = subjectIdentityKey(f);
        if (!key) return;
        if (subjExclude.checked) manualExcludedSet.add(key);
        else manualExcludedSet.delete(key);
        saveManualExcludedSet(manualExcludedSet);
        safeLocalStorageSet(SUBJECT_PICK_STORAGE_KEY, key);
        if (typeof global.LDT_REPORT_RUN === "function") {
          global.LDT_REPORT_RUN();
        }
      };

    refreshSubjectTrialView();

    renderQualityTables(
      qualityHost,
      q,
      certUnmappedLines,
      excludedAllWrongLines.concat(excludedManualLines),
    );

    statusEl.textContent =
      "已載入 " +
      files.length +
      " 個檔案；完成八十題 " +
      completed.length +
      " 人；納入回答分析 " +
      completedAnalyzed.length +
      " 人、" +
      totalTrials +
      " 筆試次" +
      (excludedAllWrong.length
        ? "（已排除全錯誤 " + excludedAllWrong.length + " 人）"
        : "") +
      "。";
  }

  global.LDT_REPORT_RUN = run;
})(typeof window !== "undefined" ? window : this);
